/**
 * 更换 slice（运维班更换册）：维护更换记录、更换页筛选与两册对不上时的挂起台账。
 *
 * 两册分治约束：
 * - 运维班只能写 replaces（含旧 / 新序列号快照）与仪器序列号；
 * - 推进到「已更换」只回写新序列号并挂「待标定」，状态由该序列号自己的第一次标定再定；
 * - 序列号冲突 / 档案已变：不回写、挂起等确认，且不动计量站的标定记录。
 * 写入逻辑统一走 utils/ledger.ts（事务 + 序列号 CAS）。
 */
import { createAsyncThunk, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { db, watchTable } from '@/utils/db';
import {
  advanceReplaceEntry,
  createReplaceEntry,
  resolveReconciliation,
  type ReplaceInput,
} from '@/utils/ledger';
import type { Replace, ReplaceFilterState, ReplaceState } from '@/types/replace';
import { createEmptyReplaceFilter } from '@/types/replace';
import type { Reconciliation } from '@/types/reconcile';
import type { RootState } from '@/stores/store';

type WithReplace = RootState;

export interface ReplaceSliceState {
  replaces: Replace[];
  reconciliations: Reconciliation[];
  filter: ReplaceFilterState;
  ready: boolean;
  error: string | null;
  lastReceipt: string;
}

const initialState: ReplaceSliceState = {
  replaces: [],
  reconciliations: [],
  filter: createEmptyReplaceFilter(),
  ready: false,
  error: null,
  lastReceipt: '',
};

export const createReplace = createAsyncThunk(
  'replace/createReplace',
  async (payload: ReplaceInput, { rejectWithValue }) => {
    try {
      return await createReplaceEntry(payload);
    } catch (error) {
      return rejectWithValue(error instanceof Error ? error.message : '更换单登记失败');
    }
  }
);

export const updateReplace = createAsyncThunk(
  'replace/updateReplace',
  async (
    payload: { id: string; patch: Partial<Omit<Replace, 'id' | 'createdAt' | 'oldSerialNo'>> },
    { rejectWithValue }
  ) => {
    try {
      // 运维班改自己的更换单：oldSerialNo 一经登记不允许从表单改写
      await db.replaces.update(payload.id, { ...payload.patch, updatedAt: Date.now() } as never);
      return payload;
    } catch (error) {
      return rejectWithValue(error instanceof Error ? error.message : '更换单更新失败');
    }
  }
);

export const transitionReplace = createAsyncThunk(
  'replace/transitionReplace',
  async (
    payload: { id: string; next: ReplaceState; operator?: string },
    { rejectWithValue }
  ) => {
    try {
      return await advanceReplaceEntry(payload.id, payload.next, payload.operator ?? '');
    } catch (error) {
      return rejectWithValue(error instanceof Error ? error.message : '更换状态流转失败');
    }
  }
);

export const removeReplace = createAsyncThunk(
  'replace/removeReplace',
  async (id: string, { rejectWithValue }) => {
    // 已有挂起待确认的更换单不允许直接删除（先处理挂起），避免台账断链
    const pending = await db.reconciliations
      .where('replaceId')
      .equals(id)
      .and((row) => row.state === '待确认')
      .count();
    if (pending > 0) {
      return rejectWithValue('该更换单存在待确认挂起，请先在挂起台账处理');
    }
    await db.replaces.delete(id);
    return id;
  }
);

/** 处理挂起：confirm 确认放行 / cancel 撤销作废 */
export const resolveReconcile = createAsyncThunk(
  'replace/resolveReconcile',
  async (
    payload: { id: string; decision: 'confirm' | 'cancel'; resolution: string; operator: string },
    { rejectWithValue }
  ) => {
    try {
      return await resolveReconciliation(
        payload.id,
        payload.decision,
        payload.resolution,
        payload.operator
      );
    } catch (error) {
      return rejectWithValue(error instanceof Error ? error.message : '挂起处理失败');
    }
  }
);

const replaceSlice = createSlice({
  name: 'replace',
  initialState,
  reducers: {
    setReplaces(state, action: PayloadAction<Replace[]>) {
      state.replaces = action.payload;
      state.ready = true;
      state.error = null;
    },
    setReconciliations(state, action: PayloadAction<Reconciliation[]>) {
      state.reconciliations = action.payload;
    },
    patchReplaceFilter(state, action: PayloadAction<Partial<ReplaceFilterState>>) {
      state.filter = { ...state.filter, ...action.payload };
    },
    resetReplaceFilter(state) {
      state.filter = createEmptyReplaceFilter();
    },
    setReplaceError(state, action: PayloadAction<string | null>) {
      state.error = action.payload;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(createReplace.rejected, (state, action) => {
        state.error = typeof action.payload === 'string' ? action.payload : '更换单登记失败';
      })
      .addCase(transitionReplace.fulfilled, (state, action) => {
        if (action.payload.kind === 'suspended') {
          state.lastReceipt = '两边数据对不上，已挂起等确认；更换单与仪器档案均未改动';
        } else if (action.payload.replace.state === '已更换') {
          state.lastReceipt = '更换完成：新序列号已回写并挂「待标定」，等该序列号第一次标定再定状态';
        } else {
          state.lastReceipt = `更换记录状态已流转到「${action.payload.replace.state}」`;
        }
      })
      .addCase(transitionReplace.rejected, (state, action) => {
        state.error = typeof action.payload === 'string' ? action.payload : '更换状态流转失败';
      })
      .addCase(removeReplace.rejected, (state, action) => {
        state.error = typeof action.payload === 'string' ? action.payload : '更换记录删除失败';
      })
      .addCase(resolveReconcile.rejected, (state, action) => {
        state.error = typeof action.payload === 'string' ? action.payload : '挂起处理失败';
      });
  },
});

export const {
  setReplaces,
  setReconciliations,
  patchReplaceFilter,
  resetReplaceFilter,
  setReplaceError,
} = replaceSlice.actions;

let started = false;

/** 启动更换册与挂起台账实时订阅（幂等） */
export function startReplaceSubscription(dispatch: (action: unknown) => void): void {
  if (started) return;
  started = true;
  watchTable<Replace>(() => db.replaces).subscribe((rows) => {
    dispatch(setReplaces(rows));
  });
  watchTable<Reconciliation>(() => db.reconciliations).subscribe((rows) => {
    dispatch(setReconciliations(rows));
  });
}

/* ------------------------------ Selector ------------------------------ */

export const selectReplaceState = (state: WithReplace): ReplaceSliceState => state.replace;
export const selectReplaces = (state: WithReplace): Replace[] => state.replace.replaces;
export const selectReconciliations = (state: WithReplace): Reconciliation[] =>
  state.replace.reconciliations;
export const selectPendingReconciliations = (state: WithReplace): Reconciliation[] =>
  state.replace.reconciliations.filter((row) => row.state === '待确认');
export const selectReplaceFilter = (state: WithReplace): ReplaceFilterState => state.replace.filter;
export const selectReplaceReady = (state: WithReplace): boolean => state.replace.ready;

export const selectReplacesOfInstrument = (
  state: WithReplace,
  instrumentId: string | null | undefined
): Replace[] => {
  if (!instrumentId) return [];
  return state.replace.replaces.filter((row) => row.instrumentId === instrumentId);
};

export default replaceSlice.reducer;
