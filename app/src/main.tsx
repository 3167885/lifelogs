import { render } from 'preact';
import { App } from './App.js';
import './styles.css';

// 阶段 2：使用 preact/compat（经 @preact/preset-vite 别名）的 hooks 与
// 类组件兼容路径；当前页面仅用 compat hooks。
render(<App />, document.getElementById('app')!);
