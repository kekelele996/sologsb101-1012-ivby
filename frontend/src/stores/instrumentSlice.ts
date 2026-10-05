/**
 * 仪器 slice：维护仪器列表、登记草稿与选中台站。
 * 序列号唯一性校验、登记后标定待办在此完成。
 *
 * 两册分治下的写入约束：
 * - 序列号只能由运维班认下更换单时改（utils/ledger.ts），本 slice 的普通编辑不写序列号；
 * - 仪器状态只由本序列号自己的标定驱动，普通编辑改状态同样走 revision 乐观锁；
 * - revision 由台账协议统一递增，页面编辑保存必须带当前 revision，对不上则拒绝。
 */
import { createAsyncThunk, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { db, createId, watchTable } from '@/utils/db';
import type { Instrument, InstrumentDraft, InstrumentState, InstrumentType } from '@/types/instrument';
import { createEmptyInstrumentDraft, daysUntilDue } from '@/types/instrument';
import type { RootState } from '@/stores/store';

/** 选择器入参统一用 RootState */
type WithInstrument = RootState;

export interface InstrumentSliceState {
  instruments: Instrument[];
  ready: boolean;
  error: string | null;
  /** 当前选中的台站（台站仪器页上下文） */
  currentStationId: string | null;
  /** 仪器登记草稿（跨页面保留） */
  draft: InstrumentDraft;
  /** 最近一次保存回执（用于页面提示） */
  lastReceipt: string;
}

const initialState: InstrumentSliceState = {
  instruments: [],
  ready: false,
  error: null,
  currentStationId: null,
  draft: createEmptyInstrumentDraft(),
  lastReceipt: '',
};

/** 序列号唯一性校验：返回冲突的仪器（排除自身） */
export async function findSerialConflict(
  serialNo: string,
  excludeId?: string
): Promise<Instrument | undefined> {
  const rows = await db.instruments.where('serialNo').equals(serialNo).toArray();
  return rows.find((row) => row.id !== excludeId);
}

export const createInstrument = createAsyncThunk(
  'instrument/createInstrument',
  async (
    payload: Omit<Instrument, 'id' | 'createdAt' | 'updatedAt' | 'revision'>,
    { rejectWithValue }
  ) => {
    const conflict = await findSerialConflict(payload.serialNo);
    if (conflict) {
      return rejectWithValue(`序列号「${payload.serialNo}」已被仪器 ${conflict.model} 占用`);
    }
    const now = Date.now();
    const row: Instrument = { ...payload, revision: 0, id: createId('ins'), createdAt: now, updatedAt: now };
    await db.instruments.put(row);
    // 登记后自动生成下一次标定待办：待标定状态 + 提示文案
    const dueInDays = daysUntilDue(null, row.installDate);
    return { row, dueInDays };
  }
);

export const updateInstrument = createAsyncThunk(
  'instrument/updateInstrument',
  async (
    payload: { id: string; patch: Partial<Instrument>; baseRevision?: number },
    { rejectWithValue }
  ) => {
    if (payload.patch.serialNo) {
      const conflict = await findSerialConflict(payload.patch.serialNo, payload.id);
      if (conflict) {
        return rejectWithValue(`序列号「${payload.patch.serialNo}」已被占用`);
      }
    }
    // 乐观锁：档案已被另一侧（标定 / 更换）先保存过时，拒绝页面编辑覆盖
    if (typeof payload.baseRevision === 'number') {
      const current = await db.instruments.get(payload.id);
      if (!current) return rejectWithValue('仪器档案不存在');
      if (current.revision !== payload.baseRevision) {
        return rejectWithValue(
          `仪器档案刚被另一侧更新（revision ${payload.baseRevision} → ${current.revision}），请刷新后再保存`
        );
      }
    }
    const { revision: _ignored, ...restPatch } = payload.patch;
    const current = await db.instruments.get(payload.id);
    if (!current) return rejectWithValue('仪器档案不存在');
    await db.instruments.update(payload.id, {
      ...restPatch,
      revision: current.revision + 1,
      updatedAt: Date.now(),
    } as never);
    return payload;
  }
);

/** 删除仪器：级联删除标定、更换与挂起记录 */
export const removeInstrument = createAsyncThunk(
  'instrument/removeInstrument',
  async (instrumentId: string) => {
    await db.transaction(
      'rw',
      [db.instruments, db.calibrations, db.replaces, db.holds],
      async () => {
        await db.calibrations.where('instrumentId').equals(instrumentId).delete();
        await db.replaces.where('instrumentId').equals(instrumentId).delete();
        await db.holds.where('instrumentId').equals(instrumentId).delete();
        await db.instruments.delete(instrumentId);
      }
    );
    return instrumentId;
  }
);

/** 批量改状态（如把超期仪器统一置为待标定）；台账状态回写同样递增 revision */
export const bulkSetInstrumentState = createAsyncThunk(
  'instrument/bulkSetInstrumentState',
  async (payload: { ids: string[]; state: InstrumentState }) => {
    const now = Date.now();
    await db.instruments
      .where('id')
      .anyOf(payload.ids)
      .modify((row) => {
        row.state = payload.state;
        row.revision += 1;
        row.updatedAt = now;
      });
    return payload;
  }
);

const instrumentSlice = createSlice({
  name: 'instrument',
  initialState,
  reducers: {
    setInstruments(state, action: PayloadAction<Instrument[]>) {
      state.instruments = action.payload;
      state.ready = true;
      state.error = null;
    },
    setInstrumentError(state, action: PayloadAction<string | null>) {
      state.error = action.payload;
    },
    selectStationForInstrument(state, action: PayloadAction<string | null>) {
      state.currentStationId = action.payload;
      state.draft.stationId = action.payload ?? '';
    },
    patchDraft(state, action: PayloadAction<Partial<InstrumentDraft>>) {
      state.draft = { ...state.draft, ...action.payload };
    },
    resetDraft(state) {
      state.draft = { ...createEmptyInstrumentDraft(), stationId: state.currentStationId ?? '' };
    },
    setReceipt(state, action: PayloadAction<string>) {
      state.lastReceipt = action.payload;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(createInstrument.fulfilled, (state, action) => {
        const dueInDays = action.payload.dueInDays;
        state.lastReceipt =
          dueInDays >= 0
            ? `仪器已登记，距下次标定 ${dueInDays} 天，请按期安排标定`
            : `仪器已登记，但安装日期距今已超过标定周期 ${Math.abs(dueInDays)} 天，请尽快安排标定`;
        state.error = null;
      })
      .addCase(createInstrument.rejected, (state, action) => {
        state.error = typeof action.payload === 'string' ? action.payload : '仪器登记失败';
      })
      .addCase(updateInstrument.rejected, (state, action) => {
        state.error = typeof action.payload === 'string' ? action.payload : '仪器更新失败';
      })
      .addCase(removeInstrument.fulfilled, (state, action) => {
        state.lastReceipt = `已删除仪器 ${action.payload}`;
      });
  },
});

export const {
  setInstruments,
  setInstrumentError,
  selectStationForInstrument,
  patchDraft,
  resetDraft,
  setReceipt,
} = instrumentSlice.actions;

let started = false;

/** 启动仪器表实时订阅（幂等） */
export function startInstrumentSubscription(dispatch: (action: unknown) => void): void {
  if (started) return;
  started = true;
  watchTable<Instrument>(() => db.instruments).subscribe((rows) => {
    dispatch(setInstruments(rows));
  });
}

/* ------------------------------ Selector ------------------------------ */

export const selectInstrumentState = (state: WithInstrument): InstrumentSliceState => state.instrument;
export const selectInstruments = (state: WithInstrument): Instrument[] => state.instrument.instruments;
export const selectInstrumentReady = (state: WithInstrument): boolean => state.instrument.ready;
export const selectInstrumentDraft = (state: WithInstrument): InstrumentDraft => state.instrument.draft;
export const selectInstrumentReceipt = (state: WithInstrument): string => state.instrument.lastReceipt;

export const selectInstrumentById = (
  state: WithInstrument,
  id: string | null | undefined
): Instrument | null => (id ? state.instrument.instruments.find((row) => row.id === id) ?? null : null);

export const selectInstrumentsOfStation = (
  state: WithInstrument,
  stationId: string | null | undefined
): Instrument[] => {
  if (!stationId) return [];
  return state.instrument.instruments
    .filter((row) => row.stationId === stationId)
    .sort((a, b) => a.type.localeCompare(b.type, 'zh-Hans-CN') || a.model.localeCompare(b.model));
};

/** 台站 id → 仪器台数 */
export const selectInstrumentCountsByStation = (state: WithInstrument): Record<string, number> => {
  const counts: Record<string, number> = {};
  state.instrument.instruments.forEach((row) => {
    counts[row.stationId] = (counts[row.stationId] ?? 0) + 1;
  });
  return counts;
};

/** 仪器类型统计 */
export const selectInstrumentTypeCounts = (state: WithInstrument): Record<InstrumentType, number> => {
  const counts: Record<InstrumentType, number> = { 宽频带: 0, 短周期: 0, 强震: 0 };
  state.instrument.instruments.forEach((row) => {
    counts[row.type] += 1;
  });
  return counts;
};

export default instrumentSlice.reducer;
