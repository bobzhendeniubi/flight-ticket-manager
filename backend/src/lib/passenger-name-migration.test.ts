import { describe, it, expect } from 'vitest';
import {
  computePassengerNameChanges,
  computeTravelerProfileNameChanges,
} from './passenger-name-migration.js';

describe('computePassengerNameChanges', () => {
  it('脏格式 fullName：ZHENG,/QINQIN → ZHENG/QINQIN', () => {
    const changes = computePassengerNameChanges({
      id: 'p1',
      fullName: 'ZHENG,/QINQIN',
      lastName: null,
      firstName: null,
    });
    expect(changes).toEqual([
      { field: 'fullName', from: 'ZHENG,/QINQIN', to: 'ZHENG/QINQIN' },
    ]);
  });

  it('lastName/firstName 各自单段规范化（不拼斜线）', () => {
    const changes = computePassengerNameChanges({
      id: 'p2',
      fullName: null,
      lastName: 'zheng,',
      firstName: 'qinqin.',
    });
    expect(changes).toEqual([
      { field: 'lastName', from: 'zheng,', to: 'ZHENG' },
      { field: 'firstName', from: 'qinqin.', to: 'QINQIN' },
    ]);
  });

  it('已干净的行返回空变更集', () => {
    const changes = computePassengerNameChanges({
      id: 'p3',
      fullName: 'ZHENG/QINQIN',
      lastName: 'ZHENG',
      firstName: 'QINQIN',
    });
    expect(changes).toEqual([]);
  });

  it('null 字段跳过，不报告变更', () => {
    const changes = computePassengerNameChanges({
      id: 'p4',
      fullName: null,
      lastName: undefined,
      firstName: null,
    });
    expect(changes).toEqual([]);
  });

  it('纯空白字段视同未填，跳过', () => {
    const changes = computePassengerNameChanges({
      id: 'p5',
      fullName: '   ',
      lastName: null,
      firstName: null,
    });
    expect(changes).toEqual([]);
  });

  it('中文名（非拉丁）原样保留，不产生变更', () => {
    const changes = computePassengerNameChanges({
      id: 'p6',
      fullName: '郑沁沁',
      lastName: null,
      firstName: null,
    });
    expect(changes).toEqual([]);
  });
});

describe('computeTravelerProfileNameChanges', () => {
  it('脏格式 fullName 产生变更', () => {
    const changes = computeTravelerProfileNameChanges({
      id: 't1',
      fullName: 'zheng, qinqin',
    });
    expect(changes).toEqual([
      { field: 'fullName', from: 'zheng, qinqin', to: 'ZHENG/QINQIN' },
    ]);
  });

  it('已干净的行返回空变更集', () => {
    const changes = computeTravelerProfileNameChanges({
      id: 't2',
      fullName: 'ZHENG/QINQIN',
    });
    expect(changes).toEqual([]);
  });

  it('null fullName 跳过', () => {
    const changes = computeTravelerProfileNameChanges({ id: 't3', fullName: null });
    expect(changes).toEqual([]);
  });

  it('中文名原样保留，不产生变更（TravelerProfile.fullName 也可能是中文名）', () => {
    const changes = computeTravelerProfileNameChanges({
      id: 't4',
      fullName: '郑沁沁',
    });
    expect(changes).toEqual([]);
  });
});
