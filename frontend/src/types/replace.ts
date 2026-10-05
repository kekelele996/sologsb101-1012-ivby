/** 更换状态机：待更换 → 已更换 → 已复核 */
export type ReplaceState = '待更换' | '已更换' | '已复核';

export const REPLACE_STATES: ReplaceState[] = ['待更换', '已更换', '已复核'];

/** 状态流转允许的下一步 */
export const REPLACE_TRANSITIONS: Record<ReplaceState, ReplaceState[]> = {
  待更换: ['已更换'],
  已更换: ['已复核', '待更换'],
  已复核: ['待更换']
};

/** 更换：仪器故障或超期后的更换记录 */
export interface Replace {
  id: string;
  /** 被更换仪器 */
  instrumentId: string;
  /** 更换原因 */
  reason: string;
  /** 旧序列号（登记更换单时快照；旧序列号的历次标定仍归旧序列号） */
  oldSerialNo: string;
  /** 新序列号（更换完成后回写仪器） */
  newSerialNo: string;
  /** 更换日期 */
  date: string;
  /** 状态 */
  state: ReplaceState;
  /**
   * 运维班认下时档案的 revision（乐观锁基准）。
   * 推「已更换」时若档案 revision 已变（计量站先保存过），不覆盖、转挂起。
   */
  baseRevision: number;
  /** 认下（流转到已更换）时间：认下后的更换单不可再改 */
  committedAt: number | null;
  /** 责任人 */
  operator: string;
  /** 备注 */
  remark: string;
  createdAt: number;
  updatedAt: number;
}

/** 常用更换原因模板 */
export const REPLACE_REASON_TEMPLATES: Array<{ key: string; reason: string }> = [
  { key: 'noise', reason: '自噪持续超标，标定不合格' },
  { key: 'response', reason: '脉冲响应异常，灵敏度漂移超限' },
  { key: 'damage', reason: '雷击或供电故障导致仪器损坏' },
  { key: 'overdue', reason: '超期未标定，按台网要求整机更换' },
  { key: 'upgrade', reason: '设备升级换代，更换为新型号' }
];

/** 更换页筛选条件 */
export interface ReplaceFilterState {
  keyword: string;
  states: ReplaceState[];
  arrayIds: string[];
}

export function createEmptyReplaceFilter(): ReplaceFilterState {
  return {
    keyword: '',
    states: [],
    arrayIds: []
  };
}

/** 是否允许状态流转 */
export function canTransition(from: ReplaceState, to: ReplaceState): boolean {
  return (REPLACE_TRANSITIONS[from] ?? []).includes(to);
}
