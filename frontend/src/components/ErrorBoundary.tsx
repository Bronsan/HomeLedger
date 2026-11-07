/**
 * Last line of defence against a white window.
 *
 * React unmounts the whole tree when a render throws, which on a packaged app
 * means a blank rectangle with no reload button and no way to reach settings —
 * the user cannot even switch back to local mode. Catching it here keeps the
 * app on screen and offers the three actions that can actually get somewhere.
 */

import { Component, type ErrorInfo, type ReactNode } from "react";
import { getMode, setMode } from "../api/client";

interface State {
  error: Error | null;
  info: string;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null, info: "" };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Keep it on the console as well: the boundary replaces the screen, so
    // without this the stack that explains *why* is gone.
    console.error("界面出错：", error, info.componentStack);
    this.setState({ info: (info.componentStack || "").trim().split("\n").slice(0, 6).join("\n") });
  }

  private reset = () => this.setState({ error: null, info: "" });

  private toLocal = () => {
    setMode("local");
    location.reload();
  };

  render() {
    const { error, info } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="connect">
        <div className="connect-card">
          <div className="connect-head">
            <div className="connect-logo danger">!</div>
            <div>
              <h1>界面没能加载出来</h1>
              <p>数据没有丢。这多半是某个组件在渲染时出错了。</p>
            </div>
          </div>

          <pre className="connect-trace">
            {error.message}
            {info ? `\n${info}` : ""}
          </pre>

          <div className="connect-actions">
            <button className="btn btn-primary" onClick={this.reset}>
              重试
            </button>
            <button className="btn" onClick={() => location.reload()}>
              重新加载
            </button>
            {getMode() !== "local" && (
              <button className="btn btn-ghost" onClick={this.toLocal}>
                改用本机模式
              </button>
            )}
          </div>

          <div className="connect-tips">
            <b>还是不行？</b>
            <ul>
              <li>「改用本机模式」不需要服务器，能打开就说明是连接问题而不是数据问题。</li>
              <li>把这个错误信息发给维护者，比「打不开」有用得多。</li>
            </ul>
          </div>
        </div>
      </div>
    );
  }
}
