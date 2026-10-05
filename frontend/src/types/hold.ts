/**
 * 挂起记录：计量站标定册与运维班更换册两边数据对不上时，
 * 一律先挂起等人工确认，绝不靠「后写盖先写」解决。
 */

/** 挂起来源：计量站侧（标定记录台）/ 运维班侧（更换提醒） */
export type HoldSource = 'calibration' | 'replacement';

export const HOLD_SOURCES: HoldSource[] = ['calibration', 'replacement'];

/** 挂起类型：序列号对不上 / 档案已被另一侧先改过（revision 冲突） */
export type HoldKind = 'serial-mismatch' | 'revision-conflict';

export const HOLD_KINDS: HoldKind[] = ['serial-mismatch', 'revision-conflict'];

/** 挂起状态：待确认 / 已确认解决 / 暂不处理 */
export type HoldStatus = 'open' | 'resolved' | 'dismissed';

export const HOLD_STATUSES: HoldStatus[] = ['open', 'resolved', 'dismissed'];

/** 挂起：两侧台账对不上时的待确认事项 */
export interface Hold {
  id: string;
  /** 涉及的仪器档案 */
  instrumentId: string;
  /** 发起侧：计量站 / 运维班 */
  source: HoldSource;
  /** 对不上的类型 */
  kind: HoldKind;
  /** 发起方认定的序列号 */
  expectedSerialNo: string;
  /** 档案实际序列号 */
  actualSerialNo: string;
  /** 发起方依据的档案 revision */
  expectedRevision: number;
  /** 档案实际 revision */
  actualRevision: number;
  /** 关联的标定记录（计量站侧有值） */
  calibrationId: string | null;
  /** 关联的更换单（运维班侧或与更换冲突时有值） */
  replaceId: string | null;
  /** 情况说明 */
  detail: string;
  status: HoldStatus;
  /** 确认结论 / 处理说明 */
  resolution: string;
  createdAt: number;
  updatedAt: number;
  resolvedAt: number | null;
}

export const HOLD_SOURCE_LABEL: Record<HoldSource, string> = {
  calibration: '计量站',
  replacement: '运维班',
};

export const HOLD_KIND_LABEL: Record<HoldKind, string> = {
  'serial-mismatch': '序列号对不上',
  'revision-conflict': '档案已被另一侧先改过',
};

export const HOLD_STATUS_LABEL: Record<HoldStatus, string> = {
  open: '待确认',
  resolved: '已确认解决',
  dismissed: '暂不处理',
};
