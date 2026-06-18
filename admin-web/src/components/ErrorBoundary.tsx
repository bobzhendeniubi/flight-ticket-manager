import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * 路由级错误边界 —— 任何页面渲染抛错时，显示可读的兜底卡片而不是整屏白屏。
 * 放在 Layout 的 <Outlet> 外层；按路由 key 重置，切页自动恢复。
 */
interface Props {
  children: ReactNode;
  /** 路由变化时传入新的 resetKey，自动清除错误态（切换页面即恢复）。 */
  resetKey?: string;
}
interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidUpdate(prev: Props) {
    // 切换路由（resetKey 变化）时清掉错误态，避免一处崩溃卡住整个后台导航。
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // 开发期留痕；生产可接入日志服务。
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="card border-rose-200 bg-rose-50">
          <h2 className="text-base font-semibold text-rose-700">这个页面出了点问题</h2>
          <p className="mt-1 text-sm text-rose-600">
            页面加载时遇到异常，已为你拦下。可以刷新重试，或切换到其它菜单。
          </p>
          <p className="mt-2 break-all text-xs text-rose-400">{this.state.error.message}</p>
          <div className="mt-3 flex gap-2">
            <button type="button" className="btn-primary text-sm" onClick={() => window.location.reload()}>
              刷新页面
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
