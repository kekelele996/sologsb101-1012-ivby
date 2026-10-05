/**
 * 两册分治写入服务（计量站标定册 / 运维班更换册）。
 *
 * 规则：
 * 1. 每一侧的写入都在同一个 IndexedDB 事务内完成「读档案 → 校验序列号 → 写自己的册子 → 按条件回写仪器」，
 *    重叠作用域的事务由 IndexedDB 串行化，后到的陈旧写入无法盖掉先到的写入（丢更新防护）。
 * 2. 计量站只写 calibrations（含序列号快照），只有序列号对得上时才回写仪器状态；
 *    运维班只写 replaces 与仪器序列号，推进到「已更换」时只置「待标定」，绝不写标定结论。
 * 3. 两边对不上：任何一侧都不回写仪器状态，登记一条 reconciliations 挂起记录等确认，
 *    且不修改对方已经认下的记录（标定记录照存为「待确认」、更换单维持原状态）。
 * 4. 计量站这侧事务失败只重试自己的标定写入（不触碰 replaces）；业务性拒绝不重试。
 */
import { db, createId } from '@/utils/db';
import type { Instrument, InstrumentState } from '@/types/instrument';
import { judgeCalibration, type Calibration, type ResponseVerdict } from '@/types/calibration';
import type { Replace, ReplaceState } from '@/types/replace';
import { canTransition } from '@/types/replace';
import {
  RECONCILE_SIDE_LABEL,
  type NewReconciliation,
  type Reconciliation,
} from '@/types/reconcile';

/** 业务性拒绝：条件不满足（非瞬态故障），不触发重试 */
export class LedgerBusinessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerBusinessError';
  }
}

/** 可重试的瞬态错误名（IndexedDB / Dexie） */
const RETRIABLE_ERROR_NAMES = new Set([
  'AbortError',
  'TransactionInactiveError',
  'DatabaseClosedError',
  'InvalidStateError',
  'UnknownError',
]);

function isRetriable(error: unknown): boolean {
  if (error instanceof LedgerBusinessError) return false;
  const name = error instanceof Error ? error.name : '';
  return RETRIABLE_ERROR_NAMES.has(name);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 计量侧事务重试包装：仅重试瞬态存储故障；重试时整段事务重跑，
 * 作用域只含标定册与仪器档案、挂起台账，天然不会改动运维班认下的更换单。
 */
export async function withMetrologyRetry<T>(
  run: () => Promise<T>,
  retries = 3
): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await run();
    } catch (error) {
      attempt += 1;
      if (attempt > retries || !isRetriable(error)) throw error;
      await sleep(40 * attempt);
    }
  }
}

/** 标定落库后的结论：已保存并回写状态，或序列号对不上已挂起 */
export type CalibrationWriteOutcome =
  | {
      kind: 'aligned';
      row: Calibration;
      /** 本次是否为该序列号自己的第一次标定（首次标定才定状态） */
      firstCalibration: boolean;
      instrumentState: InstrumentState;
    }
  | {
      kind: 'suspended';
      row: Calibration;
      reconciliation: Reconciliation;
    };

export interface CalibrationInput {
  instrumentId: string;
  /** 表单打开时看到的序列号（陈旧表单检测依据）；缺省时以事务内读到的当前序列号为准 */
  expectedSerialNo?: string;
  date: string;
  sensitivity: number;
  selfNoise: number;
  responseVerdict: ResponseVerdict;
  operator: string;
  agency: string;
  remark: string;
}

function verdictToInstrumentState(verdict: ResponseVerdict): InstrumentState {
  return verdict === '不合格' ? '待标定' : '在用';
}

/**
 * 计量站保存一次标定（新增）。
 * - 序列号与档案一致：写标定记录，并在「该序列号的第一次标定」时按结论定仪器状态；
 *   后续标定同样按结论回写状态（合格/待判定→在用，不合格→待标定）。
 * - 序列号对不上：标定记录照存但挂「待确认」，登记挂起台账，不碰仪器状态、不碰更换单。
 */
export async function saveCalibrationEntry(input: CalibrationInput): Promise<CalibrationWriteOutcome> {
  return withMetrologyRetry(async () => {
    const now = Date.now();
    return db.transaction(
      'rw',
      [db.calibrations, db.instruments, db.reconciliations],
      async (): Promise<CalibrationWriteOutcome> => {
        const instrument = await db.instruments.get(input.instrumentId);
        if (!instrument) throw new LedgerBusinessError('仪器档案不存在，无法登记标定');

        const claimedSerialNo = (input.expectedSerialNo ?? instrument.serialNo).trim();
        if (!claimedSerialNo) throw new LedgerBusinessError('序列号缺失，无法登记标定');

        const aligned = claimedSerialNo === instrument.serialNo;
        const verdict =
          input.responseVerdict ??
          judgeCalibration(instrument.type, input.sensitivity, input.selfNoise);

        // 该序列号自己的标定计数（旧序列号的历次标定不计入新序列号）
        const ownCount = await db.calibrations
          .where('instrumentId')
          .equals(instrument.id)
          .and((row) => row.serialNo === claimedSerialNo && row.reconcileState !== '已撤销')
          .count();
        const firstCalibration = ownCount === 0;

        const row: Calibration = {
          id: createId('cal'),
          instrumentId: instrument.id,
          serialNo: claimedSerialNo,
          date: input.date,
          sensitivity: input.sensitivity,
          selfNoise: input.selfNoise,
          responseVerdict: verdict,
          reconcileState: aligned ? '已对齐' : '待确认',
          reconciliationId: '',
          operator: input.operator,
          agency: input.agency,
          remark: input.remark,
          createdAt: now,
          updatedAt: now,
        };

        if (!aligned) {
          const reconciliation = await addReconciliation(
            {
              type: 'calibration-serial-mismatch',
              side: 'metrology',
              instrumentId: instrument.id,
              currentSerialNo: instrument.serialNo,
              claimedSerialNo,
              calibrationId: row.id,
              replaceId: '',
              reason: `计量站按序列号「${claimedSerialNo}」录入 ${input.date} 标定，但仪器档案当前序列号为「${instrument.serialNo}」，标定记录已挂起，仪器状态未改动`,
              resolution: '',
              state: '待确认',
              operator: input.operator,
            },
            now
          );
          row.reconciliationId = reconciliation.id;
          await db.calibrations.put(row);
          return { kind: 'suspended', row, reconciliation };
        }

        await db.calibrations.put(row);
        const nextState = verdictToInstrumentState(verdict);
        // CAS：仅当档案序列号仍是本次快照序列号时才回写状态，杜绝两侧互相覆盖
        const updated = await db.instruments
          .where('serialNo')
          .equals(claimedSerialNo)
          .and((candidate) => candidate.id === instrument.id)
          .modify({ state: nextState, updatedAt: now } as Partial<Instrument>);
        if (updated === 0) {
          throw new LedgerBusinessError('仪器档案序列号已变化，本次标定未回写状态，已挂起请核对');
        }
        return { kind: 'aligned', row, firstCalibration, instrumentState: nextState };
      }
    );
  });
}

/**
 * 计量站修改自己的标定记录（重录 / 改结论）。
 * 序列号快照沿用原记录、不可改写；若原记录的序列号已与档案对不上，转为挂起，不回写状态。
 */
export async function editCalibrationEntry(
  calibrationId: string,
  patch: Partial<Omit<Calibration, 'id' | 'instrumentId' | 'serialNo' | 'createdAt'>>
): Promise<CalibrationWriteOutcome> {
  return withMetrologyRetry(async () => {
    const now = Date.now();
    return db.transaction(
      'rw',
      [db.calibrations, db.instruments, db.reconciliations],
      async (): Promise<CalibrationWriteOutcome> => {
        const existing = await db.calibrations.get(calibrationId);
        if (!existing) throw new LedgerBusinessError('标定记录不存在');
        const instrument = await db.instruments.get(existing.instrumentId);
        if (!instrument) throw new LedgerBusinessError('仪器档案不存在，无法修改标定');

        const nextSensitivity = patch.sensitivity ?? existing.sensitivity;
        const nextNoise = patch.selfNoise ?? existing.selfNoise;
        const verdict = patch.responseVerdict ?? judgeCalibration(instrument.type, nextSensitivity, nextNoise);

        const row: Calibration = {
          ...existing,
          ...patch,
          responseVerdict: verdict,
          serialNo: existing.serialNo,
          instrumentId: existing.instrumentId,
          updatedAt: now,
        };

        const aligned = existing.serialNo === instrument.serialNo;
        if (!aligned && existing.reconcileState === '已对齐') {
          const reconciliation = await addReconciliation(
            {
              type: 'calibration-serial-mismatch',
              side: 'metrology',
              instrumentId: instrument.id,
              currentSerialNo: instrument.serialNo,
              claimedSerialNo: existing.serialNo,
              calibrationId: row.id,
              replaceId: '',
              reason: `修改标定记录时发现序列号「${existing.serialNo}」与档案当前序列号「${instrument.serialNo}」不一致，已挂起`,
              resolution: '',
              state: '待确认',
              operator: patch.operator ?? existing.operator,
            },
            now
          );
          row.reconcileState = '待确认';
          row.reconciliationId = reconciliation.id;
          await db.calibrations.put(row);
          return { kind: 'suspended', row, reconciliation };
        }

        await db.calibrations.put(row);
        return {
          kind: 'aligned',
          row,
          firstCalibration: false,
          instrumentState: instrument.state,
        };
      }
    );
  });
}

/** 挂起处理结论 */
export type ReconcileDecision = 'confirm' | 'cancel';

/**
 * 处理一条挂起：
 * - 标定侧 confirm：标定属实 → 置「已对齐」；仅当档案序列号恰为该标定序列号时按结论补定状态（归属旧序列号的历史标定不改状态）。
 * - 标定侧 cancel：标定作废 → 置「已撤销」，记录保留可追溯，但不再参与趋势与评定。
 * - 运维侧 confirm/cancel：只关挂起台账，运维班认下的更换单一个字段都不动；改新序列号后由运维班重新推进。
 */
export async function resolveReconciliation(
  reconciliationId: string,
  decision: ReconcileDecision,
  resolution: string,
  operator: string
): Promise<Reconciliation> {
  const now = Date.now();
  return db.transaction(
    'rw',
    [db.reconciliations, db.calibrations, db.instruments],
    async () => {
      const item = await db.reconciliations.get(reconciliationId);
      if (!item) throw new LedgerBusinessError('挂起记录不存在');
      if (item.state !== '待确认') throw new LedgerBusinessError('该挂起已处理，请勿重复操作');

      const nextState = decision === 'confirm' ? '已确认' : '已撤销';
      await db.reconciliations.update(reconciliationId, {
        state: nextState,
        resolution: resolution || (decision === 'confirm' ? '双方确认后放行' : '确认作废'),
        operator: operator || item.operator,
        updatedAt: now,
      } as never);

      if (item.side === 'metrology' && item.calibrationId) {
        const calibration = await db.calibrations.get(item.calibrationId);
        const instrument = await db.instruments.get(item.instrumentId);
        if (calibration) {
          if (decision === 'cancel') {
            await db.calibrations.update(calibration.id, {
              reconcileState: '已撤销',
              updatedAt: now,
            } as never);
          } else if (instrument) {
            await db.calibrations.update(calibration.id, {
              reconcileState: '已对齐',
              updatedAt: now,
            } as never);
            // 仅当档案当前序列号就是该标定序列号时，才按这条（新序列号的）标定补定状态
            if (instrument.serialNo === calibration.serialNo) {
              await db.instruments
                .where('serialNo')
                .equals(calibration.serialNo)
                .and((candidate) => candidate.id === instrument.id)
                .modify({
                  state: verdictToInstrumentState(calibration.responseVerdict),
                  updatedAt: now,
                } as Partial<Instrument>);
            }
          }
        }
      }

      return (await db.reconciliations.get(reconciliationId)) as Reconciliation;
    }
  );
}

/* ------------------------------ 运维班更换册 ------------------------------ */

export interface ReplaceInput {
  instrumentId: string;
  reason: string;
  newSerialNo: string;
  date: string;
  state: ReplaceState;
  operator: string;
  remark: string;
}

/** 登记更换单：快照旧序列号；新序列号若已被其他仪器占用直接拒绝（运维侧前置校验） */
export async function createReplaceEntry(input: ReplaceInput): Promise<Replace> {
  const now = Date.now();
  return db.transaction('rw', [db.replaces, db.instruments], async () => {
    const instrument = await db.instruments.get(input.instrumentId);
    if (!instrument) throw new LedgerBusinessError('仪器档案不存在，无法登记更换');
    const newSerialNo = input.newSerialNo.trim();
    if (!newSerialNo) throw new LedgerBusinessError('请填写新序列号');
    const conflict = await db.instruments
      .where('serialNo')
      .equals(newSerialNo)
      .and((row) => row.id !== input.instrumentId)
      .first();
    if (conflict) {
      throw new LedgerBusinessError(`新序列号「${newSerialNo}」已被仪器 ${conflict.model} 占用`);
    }
    const row: Replace = {
      id: createId('rpl'),
      instrumentId: input.instrumentId,
      reason: input.reason,
      oldSerialNo: instrument.serialNo,
      newSerialNo,
      date: input.date,
      state: input.state,
      operator: input.operator,
      remark: input.remark,
      createdAt: now,
      updatedAt: now,
    };
    await db.replaces.put(row);
    return row;
  });
}

export type ReplaceTransitionOutcome =
  | { kind: 'advanced'; replace: Replace }
  | { kind: 'suspended'; replace: Replace; reconciliation: Reconciliation };

/**
 * 推进更换状态机。
 * 流转到「已更换」时在事务内重新读档做两道校验，任一不符都只挂起、更换单维持原状态：
 * - 新序列号已被其他仪器占用（replace-serial-conflict）
 * - 档案序列号已不是更换单登记时的旧序列号（replace-stale-instrument）
 * 校验通过则 CAS 回写新序列号并置「待标定」（在用与否等该序列号第一次标定再定）。
 */
export async function advanceReplaceEntry(
  replaceId: string,
  next: ReplaceState,
  operator = ''
): Promise<ReplaceTransitionOutcome> {
  const now = Date.now();
  return db.transaction('rw', [db.replaces, db.instruments, db.reconciliations], async () => {
    const replace = await db.replaces.get(replaceId);
    if (!replace) throw new LedgerBusinessError('更换记录不存在');
    if (!canTransition(replace.state, next)) {
      throw new LedgerBusinessError(`状态机不允许从「${replace.state}」流转到「${next}」`);
    }

    if (next !== '已更换') {
      await db.replaces.update(replaceId, { state: next, updatedAt: now } as never);
      return { kind: 'advanced', replace: (await db.replaces.get(replaceId)) as Replace };
    }

    const instrument = await db.instruments.get(replace.instrumentId);
    if (!instrument) throw new LedgerBusinessError('仪器档案不存在，无法回写更换结果');
    const newSerialNo = replace.newSerialNo.trim();

    const conflict = await db.instruments
      .where('serialNo')
      .equals(newSerialNo)
      .and((row) => row.id !== replace.instrumentId)
      .first();
    if (conflict) {
      const reconciliation = await addReconciliation(
        {
          type: 'replace-serial-conflict',
          side: 'maintenance',
          instrumentId: replace.instrumentId,
          currentSerialNo: instrument.serialNo,
          claimedSerialNo: newSerialNo,
          calibrationId: '',
          replaceId: replace.id,
          reason: `更换单要写入的新序列号「${newSerialNo}」已被仪器 ${conflict.model}（${conflict.id}）占用，更换单维持「${replace.state}」`,
          resolution: '',
          state: '待确认',
          operator,
        },
        now
      );
      return { kind: 'suspended', replace, reconciliation };
    }

    if (replace.oldSerialNo && instrument.serialNo !== replace.oldSerialNo) {
      const reconciliation = await addReconciliation(
        {
          type: 'replace-stale-instrument',
          side: 'maintenance',
          instrumentId: replace.instrumentId,
          currentSerialNo: instrument.serialNo,
          claimedSerialNo: replace.oldSerialNo,
          calibrationId: '',
          replaceId: replace.id,
          reason: `更换单基于旧序列号「${replace.oldSerialNo}」，档案当前序列号已是「${instrument.serialNo}」，更换单维持「${replace.state}」`,
          resolution: '',
          state: '待确认',
          operator,
        },
        now
      );
      return { kind: 'suspended', replace, reconciliation };
    }

    // CAS 回写：仅当档案序列号仍是更换单登记的旧序列号时，才写新序列号并挂「待标定」
    const updated = await db.instruments
      .where('serialNo')
      .equals(replace.oldSerialNo)
      .and((candidate) => candidate.id === replace.instrumentId)
      .modify({ serialNo: newSerialNo, state: '待标定', updatedAt: now } as Partial<Instrument>);
    if (updated === 0) {
      throw new LedgerBusinessError('仪器档案序列号已变化，本次更换未回写，请核对后重试');
    }
    await db.replaces.update(replaceId, { state: next, updatedAt: now } as never);
    return { kind: 'advanced', replace: (await db.replaces.get(replaceId)) as Replace };
  });
}

/** 挂起台账去重：同一业务键（类型 + 标定/更换 id）已有待确认记录时复用 */
async function addReconciliation(seed: NewReconciliation, now: number): Promise<Reconciliation> {
  const existing = await db.reconciliations
    .where('state')
    .equals('待确认')
    .and((row) =>
      seed.calibrationId
        ? row.calibrationId === seed.calibrationId && row.type === seed.type
        : row.replaceId === seed.replaceId && row.type === seed.type
    )
    .first();
  if (existing) return existing;
  const row: Reconciliation = {
    ...seed,
    id: createId('rec'),
    createdAt: now,
    updatedAt: now,
  };
  await db.reconciliations.put(row);
  return row;
}

/** 挂起台账侧别文案（供页面展示） */
export const RECONCILE_SIDE_TEXT = RECONCILE_SIDE_LABEL;
