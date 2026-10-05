/**
 * 标定 slice：维护标定记录、更换记录、挂起记录、筛选条件与灵敏度派生值。
 *
 * 两册分治的落库动作统一走 utils/ledger.ts：
 * - 计量站（标定记录台）录标定：createCalibration 走 recordCalibration，
 *   状态只由本序列号自己的标定驱动；序列号/revision 对不上先挂起。
 * - 运维班（更换提醒）推更换单：transitionReplace 走 commitReplacement，
 *   回写新序列号且仪器先挂待标定；认下后的更换单锁定。
 */
import { createAsyncThunk, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { db, createId, watchTable } from '@/utils/db';
import {
  commitReplacement,
  dismissHold,
  recordCalibration,
  retryCalibrationHold,
  sanitizeReplacePatch,
} from '@/utils/ledger';
import type {
  Calibration,
  CalibrationFilterState,
  ResponseVerdict,
} from '@/types/calibration';
import { createEmptyCalibrationFilter, sensitivityDelta } from '@/types/calibration';
import type { Replace, ReplaceFilterState, ReplaceState } from '@/types/replace';
import { canTransition, createEmptyReplaceFilter } from '@/types/replace';
import type { Hold } from '@/types/hold';
import type { Instrument } from '@/types/instrument';
import type { RootState } from '@/stores/store';

/** 选择器入参统一用 RootState */
type WithCalibration = RootState;

export interface CalibrationSliceState {
  calibrations: Calibration[];
  replaces: Replace[];
  holds: Hold[];
  instruments: Instrument[];
  ready: boolean;
  error: string | null;
  filter: CalibrationFilterState;
  replaceFilter: ReplaceFilterState;
  /** 最近一次操作回执 */
  lastReceipt: string;
}

const initialState: CalibrationSliceState = {
  calibrations: [],
  replaces: [],
  holds: [],
  instruments: [],
  ready: false,
  error: null,
  filter: createEmptyCalibrationFilter(),
  replaceFilter: createEmptyReplaceFilter(),
  lastReceipt: '',
};

export interface CreateCalibrationPayload {
  instrumentId: string;
  date: string;
  sensitivity: number;
  selfNoise: number;
  responseVerdict?: ResponseVerdict;
  operator: string;
  agency: string;
  remark: string;
  /** 计量站打开表单时认定的序列号（保存时核对） */
  baseSerialNo: string;
  /** 计量站打开表单时档案的 revision（乐观锁） */
  baseRevision: number;
}

/**
 * 计量站：录一次标定。
 * 标定记录永远落库；仪器状态只在序列号/revision 都对得上时，
 * 按本序列号自己的标定结论回写；对不上则转挂起、状态不动。
 */
export const createCalibration = createAsyncThunk(
  'calibration/createCalibration',
  async (payload: CreateCalibrationPayload) => {
    return recordCalibration(payload);
  }
);

/**
 * 计量站：编辑自己的标定记录（灵敏度/自噪/结论）。
 * 只动标定册自己的行，不直接写仪器状态；状态待重试挂起或下次标定时再核定。
 */
export const updateCalibration = createAsyncThunk(
  'calibration/updateCalibration',
  async (payload: { id: string; patch: Partial<Calibration> }) => {
    await db.calibrations.update(payload.id, {
      ...payload.patch,
      updatedAt: Date.now(),
    } as never);
    return payload;
  }
);

export const removeCalibration = createAsyncThunk(
  'calibration/removeCalibration',
  async (calibrationId: string) => {
    await db.calibrations.delete(calibrationId);
    return calibrationId;
  }
);

/** 批量改响应结论（标定记录台的批量操作，只改标定册） */
export const bulkSetVerdict = createAsyncThunk(
  'calibration/bulkSetVerdict',
  async (payload: { ids: string[]; verdict: ResponseVerdict }) => {
    const now = Date.now();
    await db.calibrations
      .where('id')
      .anyOf(payload.ids)
      .modify((row) => {
        row.responseVerdict = payload.verdict;
        row.updatedAt = now;
      });
    return payload;
  }
);

/* ------------------------------ 更换记录 ------------------------------ */

export interface CreateReplacePayload {
  instrumentId: string;
  reason: string;
  newSerialNo: string;
  date: string;
  operator: string;
  remark: string;
}

/**
 * 运维班：登记更换单（待更换）。快照当前序列号为旧序列号、记录档案 revision
 * 作为日后认下的乐观锁基准；更换单不立即动仪器档案。
 */
export const createReplace = createAsyncThunk(
  'calibration/createReplace',
  async (payload: CreateReplacePayload, { rejectWithValue }) => {
    const instrument = await db.instruments.get(payload.instrumentId);
    if (!instrument) return rejectWithValue('仪器档案不存在，无法登记更换');
    const now = Date.now();
    const row: Replace = {
      id: createId('rpl'),
      instrumentId: payload.instrumentId,
      reason: payload.reason,
      oldSerialNo: instrument.serialNo,
      newSerialNo: payload.newSerialNo,
      date: payload.date,
      state: '待更换',
      baseRevision: instrument.revision,
      committedAt: null,
      operator: payload.operator,
      remark: payload.remark,
      createdAt: now,
      updatedAt: now,
    };
    await db.replaces.put(row);
    return row;
  }
);

/** 运维班：编辑更换单。认下（已更换）后的单子锁定关键字段，只能补原因/备注/责任人 */
export const updateReplace = createAsyncThunk(
  'calibration/updateReplace',
  async (payload: { id: string; patch: Partial<Replace> }, { rejectWithValue }) => {
    const current = await db.replaces.get(payload.id);
    if (!current) return rejectWithValue('更换记录不存在');
    const sanitized = sanitizeReplacePatch(payload.patch, current);
    await db.replaces.update(payload.id, { ...sanitized, updatedAt: Date.now() } as never);
    return { id: payload.id, patch: sanitized, locked: current.committedAt !== null };
  }
);

/**
 * 运维班：推进更换状态机。推到「已更换」（认下）走 ledger：
 * 序列号/revision 对不上先挂起；对得上才回写新序列号并把仪器挂待标定。
 */
export const transitionReplace = createAsyncThunk(
  'calibration/transitionReplace',
  async (
    payload: { id: string; next: ReplaceState },
    { rejectWithValue }
  ) => {
    const replace = await db.replaces.get(payload.id);
    if (!replace) return rejectWithValue('更换记录不存在');
    if (!canTransition(replace.state, payload.next)) {
      return rejectWithValue(`状态机不允许从「${replace.state}」流转到「${payload.next}」`);
    }
    const result = await commitReplacement(payload.id, payload.next);
    return { ...payload, ...result };
  }
);

export const removeReplace = createAsyncThunk(
  'calibration/removeReplace',
  async (id: string, { rejectWithValue }) => {
    const current = await db.replaces.get(id);
    // 运维班认下的更换单不动：不允许删除
    if (current && current.committedAt !== null) {
      return rejectWithValue('该更换单已认下（已更换），认下后的更换单不可删除');
    }
    await db.replaces.delete(id);
    return id;
  }
);

/* ------------------------------ 挂起处理 ------------------------------ */

/** 计量站：重试自己的挂起，只依据自己的标定记录重新核定状态，不动更换单 */
export const retryHold = createAsyncThunk(
  'calibration/retryHold',
  async (holdId: string, { rejectWithValue }) => {
    try {
      return await retryCalibrationHold(holdId);
    } catch (error) {
      return rejectWithValue(error instanceof Error ? error.message : '重试失败');
    }
  }
);

/** 两侧通用：挂起暂不处理（保留痕迹） */
export const dismissHoldThunk = createAsyncThunk(
  'calibration/dismissHold',
  async (payload: { id: string; resolution: string }, { rejectWithValue }) => {
    try {
      await dismissHold(payload.id, payload.resolution);
      return payload.id;
    } catch (error) {
      return rejectWithValue(error instanceof Error ? error.message : '挂起处理失败');
    }
  }
);

const calibrationSlice = createSlice({
  name: 'calibration',
  initialState,
  reducers: {
    setCalibrations(state, action: PayloadAction<Calibration[]>) {
      state.calibrations = action.payload;
      state.ready = true;
      state.error = null;
    },
    setReplaces(state, action: PayloadAction<Replace[]>) {
      state.replaces = action.payload;
    },
    setHolds(state, action: PayloadAction<Hold[]>) {
      state.holds = action.payload;
    },
    setInstrumentsForCalibration(state, action: PayloadAction<Instrument[]>) {
      state.instruments = action.payload;
    },
    patchFilter(state, action: PayloadAction<Partial<CalibrationFilterState>>) {
      state.filter = { ...state.filter, ...action.payload };
    },
    resetFilter(state) {
      state.filter = createEmptyCalibrationFilter();
    },
    patchReplaceFilter(state, action: PayloadAction<Partial<ReplaceFilterState>>) {
      state.replaceFilter = { ...state.replaceFilter, ...action.payload };
    },
    resetReplaceFilter(state) {
      state.replaceFilter = createEmptyReplaceFilter();
    },
    setCalibrationError(state, action: PayloadAction<string | null>) {
      state.error = action.payload;
    },
    setCalibrationReceipt(state, action: PayloadAction<string>) {
      state.lastReceipt = action.payload;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(createCalibration.fulfilled, (state, action) => {
        const r = action.payload;
        if (r.outcome === 'blocked') {
          state.lastReceipt = '标定记录已保存（归录入时序列号）；仪器状态因两侧对不上未改写，已挂起等确认';
        } else if (r.firstForSerial) {
          state.lastReceipt = `这是序列号「${r.calibration.serialSnapshot}」自己的第一次标定，仪器状态已按结论置为「${r.instrumentState}」`;
        } else {
          state.lastReceipt = `标定记录已保存，仪器状态按本次结论置为「${r.instrumentState}」`;
        }
      })
      .addCase(bulkSetVerdict.fulfilled, (state, action) => {
        state.lastReceipt = `已批量将 ${action.payload.ids.length} 条标定记录的响应结论改为「${action.payload.verdict}」`;
      })
      .addCase(transitionReplace.fulfilled, (state, action) => {
        if (action.payload.holdId) {
          state.lastReceipt = '两侧对不上，新序列号未回写，已挂起等确认';
        } else if (action.payload.next === '已更换') {
          state.lastReceipt = '更换已认下：新序列号已回写，仪器先挂待标定，等它自己的第一次标定';
        } else {
          state.lastReceipt = `更换记录状态已流转到「${action.payload.next}」`;
        }
      })
      .addCase(transitionReplace.rejected, (state, action) => {
        state.error = typeof action.payload === 'string' ? action.payload : '更换状态流转失败';
      })
      .addCase(updateReplace.fulfilled, (state, action) => {
        state.lastReceipt = action.payload.locked
          ? '该更换单已认下，序列号与日期已锁定，仅更新了原因/备注/责任人'
          : '更换记录已更新';
      })
      .addCase(updateReplace.rejected, (state, action) => {
        state.error = typeof action.payload === 'string' ? action.payload : '更换记录更新失败';
      })
      .addCase(removeReplace.rejected, (state, action) => {
        state.error = typeof action.payload === 'string' ? action.payload : '更换记录删除失败';
      });
  },
});

export const {
  setCalibrations,
  setReplaces,
  setHolds,
  setInstrumentsForCalibration,
  patchFilter,
  resetFilter,
  patchReplaceFilter,
  resetReplaceFilter,
  setCalibrationError,
  setCalibrationReceipt,
} = calibrationSlice.actions;

let started = false;

/** 启动标定 / 更换 / 挂起 / 仪器表实时订阅（幂等） */
export function startCalibrationSubscription(dispatch: (action: unknown) => void): void {
  if (started) return;
  started = true;
  watchTable<Calibration>(() => db.calibrations).subscribe((rows) => {
    dispatch(setCalibrations(rows));
  });
  watchTable<Replace>(() => db.replaces).subscribe((rows) => {
    dispatch(setReplaces(rows));
  });
  watchTable<Hold>(() => db.holds).subscribe((rows) => {
    dispatch(setHolds(rows));
  });
  watchTable<Instrument>(() => db.instruments).subscribe((rows) => {
    dispatch(setInstrumentsForCalibration(rows));
  });
}

/* ------------------------------ Selector ------------------------------ */

export const selectCalibrationState = (state: WithCalibration): CalibrationSliceState =>
  state.calibration;
export const selectCalibrations = (state: WithCalibration): Calibration[] =>
  state.calibration.calibrations;
export const selectReplaces = (state: WithCalibration): Replace[] => state.calibration.replaces;
export const selectHolds = (state: WithCalibration): Hold[] => state.calibration.holds;
export const selectOpenHolds = (state: WithCalibration): Hold[] =>
  state.calibration.holds.filter((row) => row.status === 'open');
export const selectCalibrationReady = (state: WithCalibration): boolean => state.calibration.ready;
export const selectCalibrationFilter = (state: WithCalibration): CalibrationFilterState =>
  state.calibration.filter;
export const selectReplaceFilter = (state: WithCalibration): ReplaceFilterState =>
  state.calibration.replaceFilter;
export const selectCalibrationReceipt = (state: WithCalibration): string =>
  state.calibration.lastReceipt;

export const selectCalibrationsOfInstrument = (
  state: WithCalibration,
  instrumentId: string | null | undefined
): Calibration[] => {
  if (!instrumentId) return [];
  return state.calibration.calibrations
    .filter((row) => row.instrumentId === instrumentId)
    .sort((a, b) => b.date.localeCompare(a.date));
};

export const selectReplacesOfInstrument = (
  state: WithCalibration,
  instrumentId: string | null | undefined
): Replace[] => {
  if (!instrumentId) return [];
  return state.calibration.replaces.filter((row) => row.instrumentId === instrumentId);
};

export const selectHoldsOfInstrument = (
  state: WithCalibration,
  instrumentId: string | null | undefined
): Hold[] => {
  if (!instrumentId) return [];
  return state.calibration.holds
    .filter((row) => row.instrumentId === instrumentId)
    .sort((a, b) => b.updatedAt - a.updatedAt);
};

/** 标定 id → 灵敏度变化（相对同序列号的上一次标定，跨序列号不串） */
export const selectSensitivityDeltas = (
  state: WithCalibration
): Record<string, ReturnType<typeof sensitivityDelta>> => {
  const result: Record<string, ReturnType<typeof sensitivityDelta>> = {};
  const grouped = new Map<string, Calibration[]>();
  state.calibration.calibrations.forEach((row) => {
    const key = `${row.instrumentId}::${row.serialSnapshot}`;
    const list = grouped.get(key) ?? [];
    list.push(row);
    grouped.set(key, list);
  });
  grouped.forEach((list) => {
    const sorted = [...list].sort((a, b) => a.date.localeCompare(b.date));
    sorted.forEach((row, index) => {
      const previous = index > 0 ? sorted[index - 1].sensitivity : null;
      result[row.id] = sensitivityDelta(row.sensitivity, previous);
    });
  });
  return result;
};

export default calibrationSlice.reducer;
