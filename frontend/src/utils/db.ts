/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 库名 gbseisarray，含数据结构版本号与升级迁移逻辑
 * - 升级时按 version().stores() 补齐索引
 * - 首次打开自动播种互相引用的演示数据（台阵 → 台站 → 仪器 → 标定 / 更换）
 * - 纯前端应用：不依赖任何后端服务或数据库服务
 */
import Dexie, { liveQuery, type Table } from 'dexie';
import type { SeisArray } from '@/types/array';
import type { SeisStation } from '@/types/station';
import type { Instrument } from '@/types/instrument';
import { judgeCalibration } from '@/types/calibration';
import type { Calibration } from '@/types/calibration';
import type { Replace } from '@/types/replace';
import type { Reconciliation } from '@/types/reconcile';

/** 当前数据结构版本号：每次调整字段结构必须 +1 并补迁移 */
export const DB_VERSION = 3;

/** 数据库名（浏览器 IndexedDB 中的库名） */
export const DB_NAME = 'gbseisarray';

/** localStorage 侧少量元数据键名 */
export const LS_KEYS = {
  dbVersion: 'gbseisarray:db-version',
  lastBackupAt: 'gbseisarray:last-backup-at',
  lastArrayId: 'gbseisarray:last-array-id',
} as const;

/** 备份文件结构，供 utils/export.ts 与几何页使用 */
export interface BackupPayload {
  app: 'gbseisarray';
  dbVersion: number;
  exportedAt: string;
  arrays: SeisArray[];
  stations: SeisStation[];
  instruments: Instrument[];
  calibrations: Calibration[];
  replaces: Replace[];
  reconciliations: Reconciliation[];
}

export class SeisArrayDatabase extends Dexie {
  arrays!: Table<SeisArray, string>;
  stations!: Table<SeisStation, string>;
  instruments!: Table<Instrument, string>;
  calibrations!: Table<Calibration, string>;
  replaces!: Table<Replace, string>;
  reconciliations!: Table<Reconciliation, string>;

  constructor() {
    super(DB_NAME);

    // v1：初版结构（保留历史数据，仅基础索引）
    this.version(1).stores({
      arrays: 'id, name, state',
      stations: 'id, arrayId, code',
      instruments: 'id, stationId, serialNo, state',
      calibrations: 'id, instrumentId, date',
      replaces: 'id, instrumentId, state',
    });

    // v2：补齐筛选与统计需要的索引（孔径/布设日期、经纬度/基岩、类型/序列号、灵敏度/结论、原因）
    this.version(2)
      .stores({
        arrays: 'id, name, state, apertureKm, deployDate, department, updatedAt',
        stations: 'id, arrayId, code, lat, lng, elevM, bedrock, updatedAt',
        instruments: 'id, stationId, type, model, serialNo, installDate, state, updatedAt',
        calibrations: 'id, instrumentId, date, sensitivity, selfNoise, responseVerdict, updatedAt',
        replaces: 'id, instrumentId, state, date, newSerialNo, updatedAt',
      })
      .upgrade(async (tx) => {
        // 迁移：历史数据补齐时间戳与必填字段，避免列表排序与筛选拿到 undefined
        const defaults: Array<[string, () => Record<string, unknown>]> = [
          ['arrays', () => ({ apertureKm: 0, stationCount: 0, department: '' })],
          ['stations', () => ({ lat: 0, lng: 0, elevM: 0, bedrock: '花岗岩', siteNote: '' })],
          ['instruments', () => ({ type: '宽频带', model: '', state: '在用', remark: '' })],
          ['calibrations', () => ({ sensitivity: 0, selfNoise: 0, responseVerdict: '待判定', agency: '' })],
          ['replaces', () => ({ state: '待更换', newSerialNo: '', operator: '' })],
        ];
        for (const [tableName, factory] of defaults) {
          await tx
            .table(tableName)
            .toCollection()
            .modify((row: Record<string, unknown>) => {
              const now = Date.now();
              if (typeof row.createdAt !== 'number') row.createdAt = now;
              if (typeof row.updatedAt !== 'number') row.updatedAt = row.createdAt;
              Object.assign(row, factory());
            });
        }
      });

    // v3：两册分治——标定记录加序列号快照与对账状态、更换单加旧序列号、新增挂起台账 reconciliations
    this.version(DB_VERSION)
      .stores({
        arrays: 'id, name, state, apertureKm, deployDate, department, updatedAt',
        stations: 'id, arrayId, code, lat, lng, elevM, bedrock, updatedAt',
        instruments: 'id, stationId, type, model, serialNo, installDate, state, updatedAt',
        calibrations:
          'id, instrumentId, serialNo, date, sensitivity, selfNoise, responseVerdict, reconcileState, updatedAt',
        replaces: 'id, instrumentId, state, date, oldSerialNo, newSerialNo, updatedAt',
        reconciliations: 'id, instrumentId, type, side, state, calibrationId, replaceId, updatedAt',
      })
      .upgrade(async (tx) => {
        // 历史标定：序列号快照按所属仪器当前序列号回填（v2 尚无更换快照，无法细分到旧序列号）
        const instruments = await tx.table('instruments').toArray() as Array<{
          id: string;
          serialNo?: unknown;
        }>;
        const serialById = new Map<string, string>(
          instruments.map((row) => [row.id, typeof row.serialNo === 'string' ? row.serialNo : ''])
        );
        await tx
          .table('calibrations')
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            if (typeof row.serialNo !== 'string') {
              row.serialNo = serialById.get(String(row.instrumentId)) ?? '';
            }
            if (row.reconcileState !== '已对齐' && row.reconcileState !== '待确认' && row.reconcileState !== '已撤销') {
              row.reconcileState = '已对齐';
            }
            if (typeof row.reconciliationId !== 'string') row.reconciliationId = '';
          });

        // 历史更换单：旧序列号取仪器当前序列号（当前序列号已是新号的已复核单可能不准，仅作兜底）
        await tx
          .table('replaces')
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            if (typeof row.oldSerialNo !== 'string') {
              row.oldSerialNo =
                row.state === '待更换'
                  ? serialById.get(String(row.instrumentId)) ?? ''
                  : '';
            }
          });
      });
  }
}

export const db = new SeisArrayDatabase();

/** 生成主键：短前缀 + 时间戳 + 随机串，避免多标签页写入冲突 */
export function createId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}

/** 订阅单表变化（Dexie liveQuery），返回取消订阅函数 */
export function watchTable<T>(
  table: () => Table<T, string>
): { subscribe: (cb: (rows: T[]) => void) => () => void } {
  return {
    subscribe(cb: (rows: T[]) => void): () => void {
      const observable = liveQuery(async () => table().toArray());
      const subscription = observable.subscribe({
        next: (rows: T[]) => cb(rows),
        error: () => cb([]),
      });
      return () => subscription.unsubscribe();
    },
  };
}

/* ------------------------------ 演示数据播种 ------------------------------ */

interface SeedCalibration {
  id: string;
  instrumentId: string;
  /** 序列号快照：缺省时落库统一回填仪器当前 serialNo；旧序列号的历史标定显式给旧号 */
  serialNo?: string;
  date: string;
  sensitivity: number;
  selfNoise: number;
  operator: string;
  agency: string;
  remark: string;
  /** 对账状态：默认已对齐；挂起演示样本显式给「待确认」 */
  reconcileState?: Calibration['reconcileState'];
}

interface SeedInstrument {
  id: string;
  stationId: string;
  type: Instrument['type'];
  model: string;
  serialNo: string;
  installDate: string;
  state: Instrument['state'];
  remark: string;
  calibrations: SeedCalibration[];
}

interface SeedStation {
  id: string;
  arrayId: string;
  code: string;
  lat: number;
  lng: number;
  elevM: number;
  bedrock: SeisStation['bedrock'];
  siteNote: string;
  instruments: SeedInstrument[];
}

interface SeedArray {
  id: string;
  name: string;
  apertureKm: number;
  deployDate: string;
  state: SeisArray['state'];
  department: string;
  stations: SeedStation[];
}

/**
 * 播种演示数据：2 个台阵 → 5 个台站 → 8 台仪器 → 12 条标定 + 3 条更换 + 1 条挂起，
 * 覆盖「在用 / 待标定 / 已停用」与「合格 / 不合格」、超期未标定、换号后等待首次标定及序列号对不上挂起样本。
 */
export async function seedDemoData(): Promise<void> {
  const now = Date.now();
  const today = new Date(now).toISOString().slice(0, 10);
  const daysAgo = (days: number): string => new Date(now - days * 86400000).toISOString().slice(0, 10);

  const arrays: SeedArray[] = [
    {
      id: 'arr_ltx',
      name: '龙门峡流动台阵',
      apertureKm: 24.6,
      deployDate: '2021-04-18',
      state: '运行中',
      department: '省地震局监测中心',
      stations: [
        {
          id: 'stn_ltx_01',
          arrayId: 'arr_ltx',
          code: 'LTX01',
          lat: 30.8421,
          lng: 103.5624,
          elevM: 1180,
          bedrock: '花岗岩',
          siteNote: '基岩出露，噪声本底低',
          instruments: [
            {
              id: 'ins_ltx01_bb',
              stationId: 'stn_ltx_01',
              type: '宽频带',
              model: 'CMG-3ESPC',
              serialNo: 'CMG-3E-20210418-01',
              installDate: '2021-04-18',
              state: '在用',
              remark: '主用宽频带，配 24 位采集器',
              calibrations: [
                {
                  id: 'cal_ltx01_bb_1',
                  instrumentId: 'ins_ltx01_bb',
                  date: '2023-04-20',
                  sensitivity: 1502.4,
                  selfNoise: 1.82,
                  operator: '陈立群',
                  agency: '省地震局计量站',
                  remark: '响应曲线平滑',
                },
                {
                  id: 'cal_ltx01_bb_2',
                  instrumentId: 'ins_ltx01_bb',
                  date: '2024-04-12',
                  sensitivity: 1468.9,
                  selfNoise: 1.95,
                  operator: '陈立群',
                  agency: '省地震局计量站',
                  remark: '灵敏度略降 2.2%，仍在限内',
                },
              ],
            },
            {
              id: 'ins_ltx01_st',
              stationId: 'stn_ltx_01',
              type: '短周期',
              model: 'FSS-3B',
              serialNo: 'FSS3B-20250506-24',
              installDate: '2021-04-18',
              state: '待标定',
              remark: '已换上新序列号，等待该序列号自己的第一次标定（旧号已超期）',
              calibrations: [
                {
                  id: 'cal_ltx01_st_1',
                  instrumentId: 'ins_ltx01_st',
                  serialNo: 'FSS3B-20210418-02',
                  date: '2022-05-06',
                  sensitivity: 412.6,
                  selfNoise: 2.4,
                  operator: '周渝',
                  agency: '省地震局计量站',
                  remark: '旧序列号 FSS3B-20210418-02 的首次标定；更换后历次标定仍归旧序列号',
                },
              ],
            },
          ],
        },
        {
          id: 'stn_ltx_02',
          arrayId: 'arr_ltx',
          code: 'LTX02',
          lat: 30.9187,
          lng: 103.6412,
          elevM: 1425,
          bedrock: '玄武岩',
          siteNote: '半山台基，交通便利',
          instruments: [
            {
              id: 'ins_ltx02_bb',
              stationId: 'stn_ltx_02',
              type: '宽频带',
              model: 'Trillium-120',
              serialNo: 'T120-20220315-07',
              installDate: '2022-03-15',
              state: '在用',
              remark: '井下安装，深度 42 m',
              calibrations: [
                {
                  id: 'cal_ltx02_bb_1',
                  instrumentId: 'ins_ltx02_bb',
                  date: '2024-03-18',
                  sensitivity: 1204.8,
                  selfNoise: 1.42,
                  operator: '林之遥',
                  agency: '省地震局计量站',
                  remark: '响应一致性良好',
                },
              ],
            },
            {
              id: 'ins_ltx02_st',
              stationId: 'stn_ltx_02',
              type: '短周期',
              model: 'L-4C-3D',
              serialNo: 'L4C-20220315-08',
              installDate: '2022-03-15',
              state: '已停用',
              remark: '2024 年雷击损坏，已登记更换单等待停电窗口',
              calibrations: [
                {
                  id: 'cal_ltx02_st_1',
                  instrumentId: 'ins_ltx02_st',
                  serialNo: 'L4C-20220315-08',
                  date: '2023-03-10',
                  sensitivity: 265.2,
                  selfNoise: 4.8,
                  operator: '周渝',
                  agency: '省地震局计量站',
                  remark: '自噪超标，判定不合格；该序列号若被换下，历次标定仍归本序列号',
                },
              ],
            },
          ],
        },
        {
          id: 'stn_ltx_03',
          arrayId: 'arr_ltx',
          code: 'LTX03',
          lat: 30.7802,
          lng: 103.4987,
          elevM: 986,
          bedrock: '石灰岩',
          siteNote: '河谷阶地，需注意汛期供电',
          instruments: [
            {
              id: 'ins_ltx03_bb',
              stationId: 'stn_ltx_03',
              type: '宽频带',
              model: 'STS-2.5',
              serialNo: 'STS25-20230902-11',
              installDate: '2023-09-02',
              state: '在用',
              remark: '新建站首台仪器',
              calibrations: [
                {
                  id: 'cal_ltx03_bb_1',
                  instrumentId: 'ins_ltx03_bb',
                  date: '2024-09-05',
                  sensitivity: 2251.3,
                  selfNoise: 2.05,
                  operator: '林之遥',
                  agency: '省地震局计量站',
                  remark: '脉冲响应合格',
                },
                {
                  id: 'cal_ltx03_bb_2',
                  instrumentId: 'ins_ltx03_bb',
                  serialNo: 'STS25-20230902-99',
                  date: daysAgo(2),
                  sensitivity: 2238.0,
                  selfNoise: 2.2,
                  operator: '陈立群',
                  agency: '省地震局计量站',
                  remark: '序列号录成 STS25-20230902-99，与档案 STS25-20230902-11 对不上（挂起演示）',
                  reconcileState: '待确认',
                },
              ],
            },
          ],
        },
      ],
    },
    {
      id: 'arr_hx',
      name: '海西宽频带台阵',
      apertureKm: 46.2,
      deployDate: '2019-09-25',
      state: '运行中',
      department: '国家测震台网中心',
      stations: [
        {
          id: 'stn_hx_01',
          arrayId: 'arr_hx',
          code: 'HX01',
          lat: 25.4321,
          lng: 119.3421,
          elevM: 62,
          bedrock: '花岗岩',
          siteNote: '海岛台，防盐雾处理',
          instruments: [
            {
              id: 'ins_hx01_bb',
              stationId: 'stn_hx_01',
              type: '宽频带',
              model: 'Trillium-Compact',
              serialNo: 'TC-20190925-03',
              installDate: '2019-09-25',
              state: '在用',
              remark: '海岛主用观测设备',
              calibrations: [
                {
                  id: 'cal_hx01_bb_1',
                  instrumentId: 'ins_hx01_bb',
                  date: '2023-09-28',
                  sensitivity: 1498.2,
                  selfNoise: 2.25,
                  operator: '陈立群',
                  agency: '国家测震台网计量中心',
                  remark: '响应合格',
                },
                {
                  id: 'cal_hx01_bb_2',
                  instrumentId: 'ins_hx01_bb',
                  date: '2024-09-30',
                  sensitivity: 1483.6,
                  selfNoise: 2.42,
                  operator: '陈立群',
                  agency: '国家测震台网计量中心',
                  remark: '变化 0.97%，合格',
                },
              ],
            },
            {
              id: 'ins_hx01_sm',
              stationId: 'stn_hx_01',
              type: '强震',
              model: 'ES-T',
              serialNo: 'EST-20190925-04',
              installDate: '2019-09-25',
              state: '在用',
              remark: '结构台阵强震观测',
              calibrations: [
                {
                  id: 'cal_hx01_sm_1',
                  instrumentId: 'ins_hx01_sm',
                  date: '2024-09-30',
                  sensitivity: 1.24,
                  selfNoise: 1.05,
                  operator: '周渝',
                  agency: '国家测震台网计量中心',
                  remark: '强震通道合格',
                },
              ],
            },
          ],
        },
        {
          id: 'stn_hx_02',
          arrayId: 'arr_hx',
          code: 'HX02',
          lat: 25.2894,
          lng: 119.5112,
          elevM: 128,
          bedrock: '砂岩',
          siteNote: '覆盖层较厚，需做场地响应校正',
          instruments: [
            {
              id: 'ins_hx02_bb',
              stationId: 'stn_hx_02',
              type: '宽频带',
              model: 'CMG-3ESPC',
              serialNo: 'CMG-3E-20250410-33',
              installDate: '2019-09-26',
              state: '在用',
              remark: '新序列号自己的第一次标定已合格，按结论转在用；旧序列号历次标定仍归旧号',
              calibrations: [
                {
                  id: 'cal_hx02_bb_1',
                  instrumentId: 'ins_hx02_bb',
                  serialNo: 'CMG-3E-20190926-05',
                  date: '2023-06-11',
                  sensitivity: 1388.4,
                  selfNoise: 3.9,
                  operator: '林之遥',
                  agency: '国家测震台网计量中心',
                  remark: '旧序列号 CMG-3E-20190926-05 的末次标定：自噪接近上限，判定不合格；换号后仍归旧序列号',
                },
                {
                  id: 'cal_hx02_bb_2',
                  instrumentId: 'ins_hx02_bb',
                  serialNo: 'CMG-3E-20250410-33',
                  date: daysAgo(3),
                  sensitivity: 1506.8,
                  selfNoise: 1.9,
                  operator: '陈立群',
                  agency: '国家测震台网计量中心',
                  remark: '新序列号自己的第一次标定（演示用）',
                },
              ],
            },
          ],
        },
      ],
    },
  ];

  const replaces: Replace[] = [
    {
      id: 'rpl_ltx02_st',
      instrumentId: 'ins_ltx02_st',
      reason: '雷击导致仪器损坏，标定不合格',
      oldSerialNo: 'L4C-20220315-08',
      newSerialNo: 'L4C-20250301-21',
      date: today,
      state: '待更换',
      operator: '周渝',
      remark: '新仪器已到货，待停电窗口安装；换上后先挂待标定',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'rpl_hx02_bb',
      instrumentId: 'ins_hx02_bb',
      reason: '自噪持续超标，按台网要求整机更换',
      oldSerialNo: 'CMG-3E-20190926-05',
      newSerialNo: 'CMG-3E-20250410-33',
      date: daysAgo(20),
      state: '已复核',
      operator: '林之遥',
      remark: '新序列号已回写并挂待标定，其第一次标定合格后转在用，闭环完成',
      createdAt: now - 20 * 86400000,
      updatedAt: now - 2 * 86400000,
    },
    {
      id: 'rpl_ltx01_st',
      instrumentId: 'ins_ltx01_st',
      reason: '超期未标定，更换为新型号',
      oldSerialNo: 'FSS3B-20210418-02',
      newSerialNo: 'FSS3B-20250506-24',
      date: daysAgo(60),
      state: '已更换',
      operator: '陈立群',
      remark: '序列号已回写，新序列号尚未首次标定，按规则仍挂待标定',
      createdAt: now - 60 * 86400000,
      updatedAt: now - 30 * 86400000,
    },
  ];

  const reconciliations: Reconciliation[] = [
    {
      id: 'rec_ltx03_bb_serial',
      type: 'calibration-serial-mismatch',
      side: 'metrology',
      instrumentId: 'ins_ltx03_bb',
      currentSerialNo: 'STS25-20230902-11',
      claimedSerialNo: 'STS25-20230902-99',
      calibrationId: 'cal_ltx03_bb_2',
      replaceId: '',
      reason:
        '计量站按序列号「STS25-20230902-99」录入标定，但仪器档案当前序列号为「STS25-20230902-11」，标定记录已挂起，仪器状态未改动',
      resolution: '',
      state: '待确认',
      operator: '陈立群',
      createdAt: now - 2 * 86400000,
      updatedAt: now - 2 * 86400000,
    },
  ];

  await db.transaction(
    'rw',
    [db.arrays, db.stations, db.instruments, db.calibrations, db.replaces, db.reconciliations],
    async () => {
      const stamp = (offset: number): { createdAt: number; updatedAt: number } => ({
        createdAt: now + offset,
        updatedAt: now + offset,
      });

      const arrayRows: SeisArray[] = [];
      const stationRows: SeisStation[] = [];
      const instrumentRows: Instrument[] = [];
      const calibrationRows: Calibration[] = [];

      arrays.forEach((seed, arrayIndex) => {
        const { stations, ...arrayRest } = seed;
        arrayRows.push({ ...arrayRest, stationCount: stations.length, ...stamp(arrayIndex) });
        stations.forEach((stationSeed, stationIndex) => {
          const { instruments, ...stationRest } = stationSeed;
          stationRows.push({ ...stationRest, ...stamp(100 + arrayIndex * 100 + stationIndex) });
          instruments.forEach((instrumentSeed, instrumentIndex) => {
            const { calibrations, ...instrumentRest } = instrumentSeed;
            instrumentRows.push({
              ...instrumentRest,
              ...stamp(200 + arrayIndex * 200 + stationIndex * 50 + instrumentIndex),
            });
            calibrations.forEach((calibrationSeed, calibrationIndex) => {
              const verdict = judgeCalibration(
                instrumentRest.type,
                calibrationSeed.sensitivity,
                calibrationSeed.selfNoise
              );
              calibrationRows.push({
                ...calibrationSeed,
                // 序列号快照：缺省回填仪器当前序列号（旧序列号的历史标定显式给旧号）
                serialNo: calibrationSeed.serialNo ?? instrumentRest.serialNo,
                responseVerdict: verdict,
                reconcileState: calibrationSeed.reconcileState ?? '已对齐',
                reconciliationId:
                  calibrationSeed.reconcileState === '待确认' ? 'rec_ltx03_bb_serial' : '',
                ...stamp(
                  400 + arrayIndex * 400 + stationIndex * 100 + instrumentIndex * 20 + calibrationIndex
                ),
              });
            });
          });
        });
      });

      await db.arrays.bulkPut(arrayRows);
      await db.stations.bulkPut(stationRows);
      await db.instruments.bulkPut(instrumentRows);
      await db.calibrations.bulkPut(calibrationRows);
      await db.replaces.bulkPut(replaces);
      await db.reconciliations.bulkPut(reconciliations);
    }
  );
}

/** 打开数据库并幂等播种：仅当台阵表为空时灌入演示数据 */
export async function initDatabase(): Promise<void> {
  await db.open();
  const count = await db.arrays.count();
  if (count === 0) {
    await seedDemoData();
  }
  stampDbVersion();
}

/** 清空全部业务表（导入覆盖与重置共用） */
export async function clearAllTables(): Promise<void> {
  await db.transaction(
    'rw',
    [db.arrays, db.stations, db.instruments, db.calibrations, db.replaces, db.reconciliations],
    async () => {
      await Promise.all([
        db.arrays.clear(),
        db.stations.clear(),
        db.instruments.clear(),
        db.calibrations.clear(),
        db.replaces.clear(),
        db.reconciliations.clear(),
      ]);
    }
  );
}

/** 清空并重新播种演示数据 */
export async function resetDatabase(): Promise<void> {
  await clearAllTables();
  await seedDemoData();
}

/** 统计各表行数，供页脚概览与几何页展示 */
export async function countAll(): Promise<Record<string, number>> {
  const [arrays, stations, instruments, calibrations, replaces, reconciliations] = await Promise.all([
    db.arrays.count(),
    db.stations.count(),
    db.instruments.count(),
    db.calibrations.count(),
    db.replaces.count(),
    db.reconciliations.count(),
  ]);
  return { arrays, stations, instruments, calibrations, replaces, reconciliations };
}

/** 写入结构版本号到 localStorage，便于几何页比对 */
export function stampDbVersion(): void {
  try {
    localStorage.setItem(LS_KEYS.dbVersion, String(DB_VERSION));
  } catch {
    // 隐私模式下 localStorage 不可用，忽略即可
  }
}

export function readStampedDbVersion(): number {
  try {
    const raw = localStorage.getItem(LS_KEYS.dbVersion);
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DB_VERSION;
  } catch {
    return DB_VERSION;
  }
}

export function stampBackupTime(iso: string): void {
  try {
    localStorage.setItem(LS_KEYS.lastBackupAt, iso);
  } catch {
    // 忽略
  }
}

export function readLastBackupAt(): string | null {
  try {
    return localStorage.getItem(LS_KEYS.lastBackupAt);
  } catch {
    return null;
  }
}

export function readLastArrayId(): string | null {
  try {
    return localStorage.getItem(LS_KEYS.lastArrayId);
  } catch {
    return null;
  }
}

export function writeLastArrayId(id: string | null): void {
  try {
    if (id === null) localStorage.removeItem(LS_KEYS.lastArrayId);
    else localStorage.setItem(LS_KEYS.lastArrayId, id);
  } catch {
    // 忽略
  }
}
