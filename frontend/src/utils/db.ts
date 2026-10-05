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
import type { Hold } from '@/types/hold';

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
  holds: Hold[];
}

export class SeisArrayDatabase extends Dexie {
  arrays!: Table<SeisArray, string>;
  stations!: Table<SeisStation, string>;
  instruments!: Table<Instrument, string>;
  calibrations!: Table<Calibration, string>;
  replaces!: Table<Replace, string>;
  holds!: Table<Hold, string>;

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

    // v3：两册分治（计量站标定册 / 运维班更换册）
    // - 仪器加 revision 乐观锁，两侧同时保存时后写不再盖先写
    // - 标定加序列号快照 serialSnapshot，旧序列号历次标定仍归旧序列号
    // - 更换单加旧序列号、认下基准 revision、认下时间（认下后锁定）
    // - 新增 holds 挂起表：两边对不上先挂起等确认
    this.version(DB_VERSION)
      .stores({
        arrays: 'id, name, state, apertureKm, deployDate, department, updatedAt',
        stations: 'id, arrayId, code, lat, lng, elevM, bedrock, updatedAt',
        instruments: 'id, stationId, type, model, serialNo, installDate, state, revision, updatedAt',
        calibrations: 'id, instrumentId, date, serialSnapshot, sensitivity, selfNoise, responseVerdict, updatedAt',
        replaces: 'id, instrumentId, state, date, oldSerialNo, newSerialNo, committedAt, updatedAt',
        holds: 'id, instrumentId, source, kind, status, calibrationId, replaceId, updatedAt',
      })
      .upgrade(async (tx) => {
        const now = Date.now();

        // 仪器：补 revision 乐观锁版本号
        await tx
          .table('instruments')
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            if (typeof row.revision !== 'number') row.revision = 0;
          });

        // 标定：补序列号快照（按所属仪器当前序列号回填，首次升级前的档案尚未换号）
        const instrumentRows = (await tx
          .table('instruments')
          .toArray()) as Array<{ id: string; serialNo: string }>;
        const serialById = new Map(instrumentRows.map((row) => [row.id, row.serialNo]));
        await tx
          .table('calibrations')
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            if (typeof row.serialSnapshot !== 'string' || !row.serialSnapshot) {
              row.serialSnapshot = serialById.get(String(row.instrumentId)) ?? '';
            }
          });

        // 更换单：补旧序列号、认下基准 revision、认下时间
        await tx
          .table('replaces')
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            if (typeof row.oldSerialNo !== 'string') {
              row.oldSerialNo = serialById.get(String(row.instrumentId)) ?? '';
            }
            if (typeof row.baseRevision !== 'number') row.baseRevision = 0;
            if (!('committedAt' in row)) {
              // 已更换 / 已复核的历史单子视为早先认下
              row.committedAt =
                row.state === '待更换'
                  ? null
                  : typeof row.updatedAt === 'number'
                    ? row.updatedAt
                    : now;
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
  /** 序列号快照：本次标定归哪个序列号 */
  serialSnapshot: string;
  date: string;
  sensitivity: number;
  selfNoise: number;
  operator: string;
  agency: string;
  remark: string;
}

interface SeedInstrument {
  id: string;
  stationId: string;
  type: Instrument['type'];
  model: string;
  serialNo: string;
  installDate: string;
  state: Instrument['state'];
  /** 档案版本号：每次计量站 / 运维班回写 +1 */
  revision: number;
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
 * 播种演示数据：2 个台阵 → 5 个台站 → 8 台仪器 → 14 条标定 + 3 条更换，
 * 覆盖「在用 / 待标定 / 已停用」与「合格 / 不合格」以及超期未标定样本。
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
              revision: 0,
              remark: '主用宽频带，配 24 位采集器',
              calibrations: [
                {
                  id: 'cal_ltx01_bb_1',
                  instrumentId: 'ins_ltx01_bb',
                  serialSnapshot: 'CMG-3E-20210418-01',
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
                  serialSnapshot: 'CMG-3E-20210418-01',
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
              state: '在用',
              revision: 3,
              remark: '备份仪器；2025-08 更换新序列号，旧序列号标定仍归旧序列号',
              calibrations: [
                {
                  id: 'cal_ltx01_st_1',
                  instrumentId: 'ins_ltx01_st',
                  serialSnapshot: 'FSS3B-20210418-02',
                  date: '2022-05-06',
                  sensitivity: 412.6,
                  selfNoise: 2.4,
                  operator: '周渝',
                  agency: '省地震局计量站',
                  remark: '首次标定（旧序列号 FSS3B-20210418-02）',
                },
                {
                  id: 'cal_ltx01_st_2',
                  instrumentId: 'ins_ltx01_st',
                  serialSnapshot: 'FSS3B-20250506-24',
                  date: daysAgo(30),
                  sensitivity: 436.1,
                  selfNoise: 2.1,
                  operator: '陈立群',
                  agency: '省地震局计量站',
                  remark: '新序列号自己的第一次标定，合格后转在用',
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
              revision: 0,
              remark: '井下安装，深度 42 m',
              calibrations: [
                {
                  id: 'cal_ltx02_bb_1',
                  instrumentId: 'ins_ltx02_bb',
                  serialSnapshot: 'T120-20220315-07',
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
              revision: 0,
              remark: '2024 年雷击损坏，已提交更换',
              calibrations: [
                {
                  id: 'cal_ltx02_st_1',
                  instrumentId: 'ins_ltx02_st',
                  serialSnapshot: 'L4C-20220315-08',
                  date: '2023-03-10',
                  sensitivity: 265.2,
                  selfNoise: 4.8,
                  operator: '周渝',
                  agency: '省地震局计量站',
                  remark: '自噪超标，判定不合格',
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
              serialNo: 'STS25-20250920-55',
              installDate: '2023-09-02',
              state: '待标定',
              revision: 2,
              remark: '10 天前换上新序列号，等它自己的第一次标定；旧序列号标定仍归旧序列号',
              calibrations: [
                {
                  id: 'cal_ltx03_bb_1',
                  instrumentId: 'ins_ltx03_bb',
                  serialSnapshot: 'STS25-20230902-11',
                  date: '2024-09-05',
                  sensitivity: 2251.3,
                  selfNoise: 2.05,
                  operator: '林之遥',
                  agency: '省地震局计量站',
                  remark: '旧序列号的标定，归旧序列号 STS25-20230902-11',
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
              revision: 0,
              remark: '海岛主用观测设备',
              calibrations: [
                {
                  id: 'cal_hx01_bb_1',
                  instrumentId: 'ins_hx01_bb',
                  serialSnapshot: 'TC-20190925-03',
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
                  serialSnapshot: 'TC-20190925-03',
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
              revision: 0,
              remark: '结构台阵强震观测',
              calibrations: [
                {
                  id: 'cal_hx01_sm_1',
                  instrumentId: 'ins_hx01_sm',
                  serialSnapshot: 'EST-20190925-04',
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
              state: '待标定',
              revision: 2,
              remark: '已换上新序列号，等这个序列号自己的第一次标定；旧序列号标定仍归旧序列号',
              calibrations: [
                {
                  id: 'cal_hx02_bb_1',
                  instrumentId: 'ins_hx02_bb',
                  serialSnapshot: 'CMG-3E-20190926-05',
                  date: '2023-06-11',
                  sensitivity: 1388.4,
                  selfNoise: 3.9,
                  operator: '林之遥',
                  agency: '国家测震台网计量中心',
                  remark: '旧序列号自噪超标，判定不合格（归旧序列号 CMG-3E-20190926-05）',
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
      baseRevision: 0,
      committedAt: null,
      operator: '周渝',
      remark: '新仪器已到货，待停电窗口安装',
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
      state: '已更换',
      baseRevision: 1,
      committedAt: now - 20 * 86400000,
      operator: '林之遥',
      remark: '已完成安装，新序列号先挂待标定，等它自己的第一次标定',
      createdAt: now - 20 * 86400000,
      updatedAt: now - 18 * 86400000,
    },
    {
      id: 'rpl_ltx01_st',
      instrumentId: 'ins_ltx01_st',
      reason: '超期未标定，更换为新型号',
      oldSerialNo: 'FSS3B-20210418-02',
      newSerialNo: 'FSS3B-20250506-24',
      date: daysAgo(60),
      state: '已复核',
      baseRevision: 1,
      committedAt: now - 60 * 86400000,
      operator: '陈立群',
      remark: '新序列号首次标定合格后复核闭环',
      createdAt: now - 60 * 86400000,
      updatedAt: now - 30 * 86400000,
    },
    {
      id: 'rpl_ltx03_bb',
      instrumentId: 'ins_ltx03_bb',
      reason: '设备升级换代，更换为新型号',
      oldSerialNo: 'STS25-20230902-11',
      newSerialNo: 'STS25-20250920-55',
      date: daysAgo(10),
      state: '已更换',
      baseRevision: 1,
      committedAt: now - 10 * 86400000,
      operator: '周渝',
      remark: '新序列号先挂待标定，等它自己的第一次标定',
      createdAt: now - 10 * 86400000,
      updatedAt: now - 10 * 86400000,
    },
  ];

  // 挂起样本：运维班先把 LTX03 换成新序列号，计量站随后按旧序列号录标定，
  // 序列号对不上 → 标定照存（归旧序列号），仪器状态不动，先挂起等确认
  const holds: Hold[] = [
    {
      id: 'hold_ltx03_serial',
      instrumentId: 'ins_ltx03_bb',
      source: 'calibration',
      kind: 'serial-mismatch',
      expectedSerialNo: 'STS25-20230902-11',
      actualSerialNo: 'STS25-20250920-55',
      expectedRevision: 1,
      actualRevision: 2,
      calibrationId: 'cal_ltx03_bb_1',
      replaceId: 'rpl_ltx03_bb',
      detail: '计量站按旧序列号 STS25-20230902-11 录标定，运维班已把档案换成新序列号 STS25-20250920-55；标定归旧序列号，仪器状态未改写，待确认。',
      status: 'open',
      resolution: '',
      createdAt: now - 5 * 86400000,
      updatedAt: now - 5 * 86400000,
      resolvedAt: null,
    },
  ];

  await db.transaction(
    'rw',
    [db.arrays, db.stations, db.instruments, db.calibrations, db.replaces, db.holds],
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
                responseVerdict: verdict,
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
      await db.holds.bulkPut(holds);
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
    [db.arrays, db.stations, db.instruments, db.calibrations, db.replaces, db.holds],
    async () => {
      await Promise.all([
        db.arrays.clear(),
        db.stations.clear(),
        db.instruments.clear(),
        db.calibrations.clear(),
        db.replaces.clear(),
        db.holds.clear(),
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
  const [arrays, stations, instruments, calibrations, replaces, holds] = await Promise.all([
    db.arrays.count(),
    db.stations.count(),
    db.instruments.count(),
    db.calibrations.count(),
    db.replaces.count(),
    db.holds.count(),
  ]);
  return { arrays, stations, instruments, calibrations, replaces, holds };
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
