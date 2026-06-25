import { create } from 'zustand';

/**
 * 全局"座位变更"信号。
 *
 * 任何会改变机位库存的操作（建单、批量建单、订单状态流转/删除/退款等）成功后
 * 调用 bumpSeats()；各座位视图（航班管理、座位统计等）订阅 seatsVersion，
 * 在其变化时重新拉取班次余位，保证多处展示与后端权威口径一致、自动刷新。
 */
interface FlightSeatsState {
  seatsVersion: number;
  bumpSeats: () => void;
}

export const useFlightSeats = create<FlightSeatsState>((set) => ({
  seatsVersion: 0,
  bumpSeats: () => set((s) => ({ seatsVersion: s.seatsVersion + 1 })),
}));
