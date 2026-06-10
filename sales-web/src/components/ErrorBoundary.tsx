/**
 * 全局错误边界 — 任何路由组件渲染期抛错都兜在这里，不再整页白屏。
 *
 * 公测反馈（谢晓枝/李孟）：结算路径偶发白屏。根因多为旧 localStorage 购物车
 * 数据缺字段导致渲染抛 TypeError。这里给两条恢复路径：
 *   1. 刷新页面
 *   2. 清空购物车（localStorage ftm-cart）后刷新 —— 专治脏购物车数据
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

const CART_STORAGE_KEY = 'ftm-cart';

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 仅开发态输出，方便定位；生产路径不打 console（接监控时换上报）
    if (import.meta.env.DEV) {
      console.error('[ErrorBoundary]', error, info.componentStack);
    }
  }

  private handleReload = (): void => {
    window.location.reload();
  };

  private handleClearCartAndReload = (): void => {
    try {
      localStorage.removeItem(CART_STORAGE_KEY);
    } catch {
      /* noop — localStorage 不可用时直接刷新 */
    }
    window.location.reload();
  };

  render(): ReactNode {
    if (!this.state.error) return this.props.children;

    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 px-4">
        <div className="card max-w-md w-full text-center py-12">
          <div className="text-5xl">😵</div>
          <h1 className="mt-3 text-2xl font-bold text-slate-900">页面出错了</h1>
          <p className="mt-2 text-xs text-slate-400 break-all">{this.state.error.message}</p>
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <button type="button" className="btn-primary" onClick={this.handleReload}>
              刷新页面
            </button>
            <button type="button" className="btn-secondary" onClick={this.handleClearCartAndReload}>
              清空购物车后刷新
            </button>
          </div>
        </div>
      </div>
    );
  }
}
