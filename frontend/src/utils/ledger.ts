/**
 * 两册台账协议（计量站标定册 / 运维班更换册）的唯一写入入口。
 *
 * 职责边界（档案 Instrument 上的字段分属两侧）：
 * - 计量站（calibration）：管标定记录、灵敏度、响应结论；
 *   只有「本序列号自己的标定结果」能驱动 instrument.state。
 * - 运维班（replacement）：管更换单、新序列号、更换进度；
 *   推到「已更换」时才能写 instrument.serialNo，且仪器先挂「待标定」。
 *
 * 并发保护：
 * - instrument.revision 乐观锁：保存时档案已被另一侧先改过 → 不覆盖，转挂起。
 * - 序列号对不上 → 不覆盖，转挂起（holds 表，等人工确认）。
 * - 标定记录带序列号快照：旧序列号的历次标定永远归旧序列号。
 * - 计量站侧出错重试只动自己的标定记录；运维班认下（已更换）的更换单锁定不可改。
 */
import { db, createId } from '@/utils/db';
import { judgeCalibration } from '@/types/calibration';
import type { Calibration, ResponseVerdict } from '@/types/calibration';
import type { Replace, ReplaceState } from '@/types/replace';
import type { Hold, HoldKind, HoldSource } from '@/types/hold';
import type { InstrumentState } from '@/types/instrument';

/** 台账协议冲突：需要转挂起或提示用户，绝不能静默覆盖 */
export class LedgerError extends Error {
  constructor(
    public code:
      | 'INSTRUMENT_NOT_FOUND'
      | 'REPLACE_NOT_FOUND'
      | 'TRANSITION_DENIED'
      | 'REPLACE_LOCKED'
      | 'HOLD_NOT_FOUND'
      | 'CALIBRATION_NOT_FOUND',
    message: string
  ) {
    super(message);
    this.name = 'LedgerError';
  }
}

/** 标定录入入参（结论缺省按灵敏度/自噪自动初判，计量站手选结论以手选为准） */
export interface RecordCalibrationInput {
  instrumentId: string;
  date: string;
  sensitivity: number;
  selfNoise: number;
  /** 计量站可手选响应结论；不传则自动初判 */
  responseVerdict?: ResponseVerdict;
  operator: string;
  agency: string;
  remark: string;
  /** 计量站打开表单时认定的序列号（保存时核对，对不上先挂起） */
  baseSerialNo: string;
  /** 计量站打开表单时档案的 revision */
  baseRevision: number;
}

/** 标定录入结果：saved 为正常落库；blocked 为已保存但状态回写被挂起拦住 */
export interface RecordCalibrationResult {
  outcome: 'saved' | 'blocked';
  calibration: Calibration;
  holdId?: string;
  blockedReason?: string;
  /** 是否为该序列号自己的第一次标定（首次标定才定状态） */
  firstForSerial: boolean;
  instrumentState: InstrumentState;
}

/** 挂起结果 */
export interface HoldOutcome {
  holdId: string;
  kind: HoldKind;
  detail: string;
}

/** 记一条挂起：同一仪器 / 同侧 / 同类型 / 同认定序列号已有未确认挂起时复用，避免重复刷屏 */
async function raiseHold(params: {
  instrumentId: string;
  source: HoldSource;
  kind: HoldKind;
  expectedSerialNo: string;
  actualSerialNo: string;
  expectedRevision: number;
  actualRevision: number;
  calibrationId?: string | null;
  replaceId?: string | null;
  detail: string;
}): Promise<Hold> {
  const existing = await db.holds
    .where('instrumentId')
    .equals(params.instrumentId)
    .toArray();
  const duplicate = existing.find(
    (row) =>
      row.status === 'open' &&
      row.source === params.source &&
      row.kind === params.kind &&
      row.expectedSerialNo === params.expectedSerialNo
  );
  const now = Date.now();
  if (duplicate) {
    await db.holds.update(duplicate.id, {
      actualSerialNo: params.actualSerialNo,
      actualRevision: params.actualRevision,
      calibrationId: params.calibrationId ?? duplicate.calibrationId,
      replaceId: params.replaceId ?? duplicate.replaceId,
      detail: params.detail,
      updatedAt: now,
    } as never);
    return { ...duplicate, ...params, updatedAt: now } as Hold;
  }
  const row: Hold = {
    id: createId('hold'),
    instrumentId: params.instrumentId,
    source: params.source,
    kind: params.kind,
    expectedSerialNo: params.expectedSerialNo,
    actualSerialNo: params.actualSerialNo,
    expectedRevision: params.expectedRevision,
    actualRevision: params.actualRevision,
    calibrationId: params.calibrationId ?? null,
    replaceId: params.replaceId ?? null,
    detail: params.detail,
    status: 'open',
    resolution: '',
    createdAt: now,
    updatedAt: now,
    resolvedAt: null,
  };
  await db.holds.put(row);
  return row;
}

/** 计量站：录一次标定。标定记录永远落库（自己的册子）；状态回写受两册协议保护 */
export async function recordCalibration(input: RecordCalibrationInput): Promise<RecordCalibrationResult> {
  const instrument = await db.instruments.get(input.instrumentId);
  if (!instrument) {
    throw new LedgerError('INSTRUMENT_NOT_FOUND', '仪器档案不存在，无法录入标定');
  }
  const now = Date.now();
  // 响应结论：计量站手选优先，缺省按灵敏度/自噪自动初判
  const verdict: ResponseVerdict =
    input.responseVerdict ?? judgeCalibration(instrument.type, input.sensitivity, input.selfNoise);
  // 序列号对不上时，本次标定归计量站认定的序列号（通常是刚被换走的旧序列号）；
  // 对得上时归档案当前序列号。旧序列号的历次标定永远归旧序列号。
  const serialMismatch = input.baseSerialNo !== '' && input.baseSerialNo !== instrument.serialNo;
  const serialSnapshot = serialMismatch ? input.baseSerialNo : instrument.serialNo;
  const calibration: Calibration = {
    id: createId('cal'),
    instrumentId: input.instrumentId,
    serialSnapshot,
    date: input.date,
    sensitivity: input.sensitivity,
    selfNoise: input.selfNoise,
    responseVerdict: verdict,
    operator: input.operator,
    agency: input.agency,
    remark: input.remark,
    createdAt: now,
    updatedAt: now,
  };

  // 先核对：序列号对不上（运维班刚推过更换单）→ 标定照存（归认定序列号），状态不动，挂起
  if (serialMismatch) {
    const hold = await raiseHold({
      instrumentId: input.instrumentId,
      source: 'calibration',
      kind: 'serial-mismatch',
      expectedSerialNo: input.baseSerialNo,
      actualSerialNo: instrument.serialNo,
      expectedRevision: input.baseRevision,
      actualRevision: instrument.revision,
      calibrationId: calibration.id,
      replaceId: null,
      detail: `标定录入时认定序列号「${input.baseSerialNo}」，档案已被运维班更换为「${instrument.serialNo}」；本次标定归「${input.baseSerialNo}」（旧序列号历次标定仍归旧序列号），仪器状态未改写，待确认新序列号是否需另录首次标定。`,
    });
    await db.calibrations.put(calibration);
    return {
      outcome: 'blocked',
      calibration,
      holdId: hold.id,
      blockedReason: hold.detail,
      firstForSerial: false,
      instrumentState: instrument.state,
    };
  }

  // 再核对：revision 对不上（两侧同时保存，对方先落库）→ 标定照存，状态不动，挂起
  if (input.baseRevision !== instrument.revision) {
    const hold = await raiseHold({
      instrumentId: input.instrumentId,
      source: 'calibration',
      kind: 'revision-conflict',
      expectedSerialNo: serialSnapshot,
      actualSerialNo: serialSnapshot,
      expectedRevision: input.baseRevision,
      actualRevision: instrument.revision,
      calibrationId: calibration.id,
      detail: `标定保存时档案 revision 已从 ${input.baseRevision} 变为 ${instrument.revision}（另一侧先保存）。标定记录已落库，仪器状态未改写，请确认后重试。`,
    });
    await db.calibrations.put(calibration);
    return {
      outcome: 'blocked',
      calibration,
      holdId: hold.id,
      blockedReason: hold.detail,
      firstForSerial: false,
      instrumentState: instrument.state,
    };
  }

  // 校验通过：标定与状态回写在同一事务，状态只由本序列号自己的标定结论驱动
  const nextState: InstrumentState = verdict === '不合格' ? '待标定' : '在用';
  const priorCount = await db.calibrations
    .where('instrumentId')
    .equals(input.instrumentId)
    .filter((row) => row.serialSnapshot === serialSnapshot)
    .count();
  await db.transaction('rw', [db.calibrations, db.instruments], async () => {
    await db.calibrations.put(calibration);
    await db.instruments.update(instrument.id, {
      state: nextState,
      revision: instrument.revision + 1,
      updatedAt: now,
    } as never);
  });
  return {
    outcome: 'saved',
    calibration,
    firstForSerial: priorCount === 0,
    instrumentState: nextState,
  };
}

/**
 * 计量站：重试自己的挂起。只依据自己的标定记录重新核状态，
 * 绝不修改运维班认下的更换单。
 */
export async function retryCalibrationHold(holdId: string): Promise<{ resolved: boolean; state: InstrumentState }> {
  const hold = await db.holds.get(holdId);
  if (!hold) throw new LedgerError('HOLD_NOT_FOUND', '挂起记录不存在');
  const instrument = await db.instruments.get(hold.instrumentId);
  if (!instrument) throw new LedgerError('INSTRUMENT_NOT_FOUND', '仪器档案不存在');

  // 找到本次挂起对应的标定；若挂起未带标定 id，取该仪器最新一条标定
  let anchor = hold.calibrationId ? await db.calibrations.get(hold.calibrationId) : undefined;
  if (!anchor) {
    anchor = await db.calibrations
      .where('instrumentId')
      .equals(hold.instrumentId)
      .sortBy('date')
      .then((rows) => rows[rows.length - 1]);
  }
  if (!anchor) throw new LedgerError('CALIBRATION_NOT_FOUND', '标定记录不存在或已删除');

  // 标定按序列号快照归属：快照序列号与档案当前序列号仍对不上 → 维持挂起
  if (anchor.serialSnapshot !== instrument.serialNo) {
    return { resolved: false, state: instrument.state };
  }

  const now = Date.now();
  const nextState: InstrumentState = anchor.responseVerdict === '不合格' ? '待标定' : '在用';
  await db.transaction('rw', [db.instruments, db.holds], async () => {
    await db.instruments.update(instrument.id, {
      state: nextState,
      revision: instrument.revision + 1,
      updatedAt: now,
    } as never);
    await db.holds.update(holdId, {
      status: 'resolved',
      resolution: `计量站重试：序列号已对上（${instrument.serialNo}），按本序列号标定结论置为「${nextState}」`,
      resolvedAt: now,
      updatedAt: now,
    } as never);
  });
  return { resolved: true, state: nextState };
}

/** 运维班：推进更换状态机。推到「已更换」时回写新序列号，仪器先挂待标定 */
export async function commitReplacement(
  replaceId: string,
  next: ReplaceState,
  baseRevision?: number
): Promise<{ replace: Replace; holdId?: string }> {
  const replace = await db.replaces.get(replaceId);
  if (!replace) throw new LedgerError('REPLACE_NOT_FOUND', '更换单不存在');

  // 仅在「待更换 → 已更换」认下时做两册核对；已更换/已复核之间的流转不动档案
  if (next !== '已更换' || replace.state !== '待更换') {
    const now = Date.now();
    await db.replaces.update(replaceId, { state: next, updatedAt: now } as never);
    return { replace: { ...replace, state: next, updatedAt: now } };
  }

  const instrument = await db.instruments.get(replace.instrumentId);
  if (!instrument) throw new LedgerError('INSTRUMENT_NOT_FOUND', '仪器档案不存在');
  const now = Date.now();

  // 校验 1：新序列号已被别的仪器占用 → 挂起，等确认（不能写重号）
  const occupied = await db.instruments.where('serialNo').equals(replace.newSerialNo).toArray();
  if (occupied.some((row) => row.id !== instrument.id)) {
    const hold = await raiseHold({
      instrumentId: instrument.id,
      source: 'replacement',
      kind: 'serial-mismatch',
      expectedSerialNo: replace.newSerialNo,
      actualSerialNo: instrument.serialNo,
      expectedRevision: baseRevision ?? replace.baseRevision,
      actualRevision: instrument.revision,
      replaceId: replace.id,
      detail: `更换单要写入的新序列号「${replace.newSerialNo}」已被其他仪器占用，更换单未推进，待确认序列号。`,
    });
    return { replace, holdId: hold.id };
  }

  // 校验 2：登记更换单时的旧序列号与档案当前序列号对不上（期间档案被动过）→ 挂起
  if (replace.oldSerialNo && replace.oldSerialNo !== instrument.serialNo) {
    const hold = await raiseHold({
      instrumentId: instrument.id,
      source: 'replacement',
      kind: 'serial-mismatch',
      expectedSerialNo: replace.oldSerialNo,
      actualSerialNo: instrument.serialNo,
      expectedRevision: baseRevision ?? replace.baseRevision,
      actualRevision: instrument.revision,
      replaceId: replace.id,
      detail: `更换单登记时旧序列号为「${replace.oldSerialNo}」，档案当前序列号为「${instrument.serialNo}」，两边对不上，更换单未推进，待确认。`,
    });
    return { replace, holdId: hold.id };
  }

  // 校验 3：乐观锁——计量站先保存过标定，档案 revision 已变 → 不覆盖，挂起
  const expectedRevision = baseRevision ?? replace.baseRevision;
  if (expectedRevision !== instrument.revision) {
    const hold = await raiseHold({
      instrumentId: instrument.id,
      source: 'replacement',
      kind: 'revision-conflict',
      expectedSerialNo: instrument.serialNo,
      actualSerialNo: instrument.serialNo,
      expectedRevision,
      actualRevision: instrument.revision,
      replaceId: replace.id,
      detail: `认下更换单时档案 revision 已从 ${expectedRevision} 变为 ${instrument.revision}（计量站刚录过标定）。新序列号未回写，待确认后重新认下。`,
    });
    return { replace, holdId: hold.id };
  }

  // 认下：更换单、新序列号、待标定状态在同一事务落库；认下后更换单锁定
  const committed: Replace = {
    ...replace,
    state: '已更换',
    baseRevision: instrument.revision,
    committedAt: now,
    updatedAt: now,
  };
  await db.transaction('rw', [db.replaces, db.instruments], async () => {
    await db.replaces.put(committed);
    await db.instruments.update(instrument.id, {
      serialNo: replace.newSerialNo,
      // 换上新序列号后先挂待标定，等这个序列号自己的第一次标定出来再定状态
      state: '待标定',
      revision: instrument.revision + 1,
      updatedAt: now,
    } as never);
  });
  return { replace: committed };
}

/** 挂起暂不处理（两侧都可用）：保留挂起痕迹，不再阻断后续操作 */
export async function dismissHold(holdId: string, resolution: string): Promise<void> {
  const hold = await db.holds.get(holdId);
  if (!hold) throw new LedgerError('HOLD_NOT_FOUND', '挂起记录不存在');
  const now = Date.now();
  await db.holds.update(holdId, {
    status: 'dismissed',
    resolution: resolution || '人工确认暂不处理',
    resolvedAt: now,
    updatedAt: now,
  } as never);
}

/** 认下（已更换）后的更换单锁定字段：运维班认下的单子不可改回这些内容 */
const REPLACE_LOCKED_KEYS = [
  'instrumentId',
  'oldSerialNo',
  'newSerialNo',
  'date',
  'state',
  'committedAt',
] as const;

/** 运维班：编辑更换单（认下后锁定关键字段，只能补原因/备注/责任人） */
export function sanitizeReplacePatch(patch: Partial<Replace>, current: Replace): Partial<Replace> {
  if (current.committedAt === null) return patch;
  const sanitized: Partial<Replace> = { ...patch };
  REPLACE_LOCKED_KEYS.forEach((key) => {
    if (key in sanitized) delete sanitized[key as keyof Replace];
  });
  return sanitized;
}
