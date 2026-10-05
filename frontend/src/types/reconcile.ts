/**
 * 挂起台账（Reconciliation）：计量站标定册与运维班更换册两边数据对不上时，
 * 任何一侧都不得直接回写仪器状态，先登记一条挂起记录，等双方确认后再放行或撤销。
 *
 * 典型场景：
 * - calibration-serial-mismatch：标定记录上的序列号快照与仪器档案当前序列号不一致
 *   （仪器已被更换，计量站仍在给旧序列号录标定，或新序列号尚未挂上）。
 * - replace-serial-conflict：更换单要写入的新序列号已被另一台仪器占用。
 * - replace-stale-instrument：推进更换时仪器序列号已发生变化（更换单基于旧档案）。
 */
export type ReconcileType =
  | 'calibration-serial-mismatch'
  | 'replace-serial-conflict'
  | 'replace-stale-instrument';

export const RECONCILE_TYPES: ReconcileType[] = [
  'calibration-serial-mismatch',
  'replace-serial-conflict',
  'replace-stale-instrument',
];

export const RECONCILE_TYPE_LABEL: Record<ReconcileType, string> = {
  'calibration-serial-mismatch': '标定序列号对不上',
  'replace-serial-conflict': '新序列号已被占用',
  'replace-stale-instrument': '更换单与档案不一致',
};

/** 挂起状态：待确认 → 已确认（放行）/ 已撤销 */
export type ReconcileState = '待确认' | '已确认' | '已撤销';

export const RECONCILE_STATES: ReconcileState[] = ['待确认', '已确认', '已撤销'];

export const RECONCILE_STATE_LABEL: Record<ReconcileState, string> = {
  待确认: '待确认',
  已确认: '已确认放行',
  已撤销: '已撤销',
};

/** 来源侧别：计量站（标定册）/ 运维班（更换册） */
export type ReconcileSide = 'metrology' | 'maintenance';

export const RECONCILE_SIDE_LABEL: Record<ReconcileSide, string> = {
  metrology: '计量站',
  maintenance: '运维班',
};

/** 挂起记录：两册对不上时先挂起，等确认 */
export interface Reconciliation {
  id: string;
  /** 挂起类型 */
  type: ReconcileType;
  /** 发起侧 */
  side: ReconcileSide;
  /** 涉及仪器档案 id */
  instrumentId: string;
  /** 档案当前序列号（挂起发生时） */
  currentSerialNo: string;
  /** 对方主张的序列号（标定记录快照 / 更换单新序列号） */
  claimedSerialNo: string;
  /** 关联标定记录 id（标定侧挂起） */
  calibrationId: string;
  /** 关联更换记录 id（运维侧挂起） */
  replaceId: string;
  /** 挂起原因说明 */
  reason: string;
  /** 处理备注（确认 / 撤销时填写） */
  resolution: string;
  /** 状态 */
  state: ReconcileState;
  /** 登记人 */
  operator: string;
  createdAt: number;
  updatedAt: number;
}

/** 挂起记录入参（id 与时间戳由存储层补齐） */
export type NewReconciliation = Omit<Reconciliation, 'id' | 'createdAt' | 'updatedAt'>;

export function createEmptyReconciliation(partial: Partial<NewReconciliation> = {}): NewReconciliation {
  return {
    type: 'calibration-serial-mismatch',
    side: 'metrology',
    instrumentId: '',
    currentSerialNo: '',
    claimedSerialNo: '',
    calibrationId: '',
    replaceId: '',
    reason: '',
    resolution: '',
    state: '待确认',
    operator: '',
    ...partial,
  };
}
