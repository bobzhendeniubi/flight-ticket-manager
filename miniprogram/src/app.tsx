/**
 * 小程序根组件。
 * Taro 的 App 组件只是一个容器；真正的页面逻辑在 pages/*。
 */
import { PropsWithChildren } from 'react';
import './app.scss';

function App({ children }: PropsWithChildren<unknown>) {
  return children as JSX.Element;
}

export default App;
