# 阅读器

极简瑞士风的 macOS PDF 阅读器，左侧 Markdown 笔记，右侧 PDF。

技术栈：Electron + React + Vite + TypeScript，PDF 渲染用 pdf.js，Markdown 用 react-markdown + GFM。

应用图标源文件在 `build/icon.svg`，其他备选方案在 `build/icon-options/`。

## 运行

```bash
npm install
npm run dev     # 开发模式（Vite 热更新 + Electron）
npm run dist    # 打包为 .dmg（Apple Silicon），输出到 release/
```

## 笔记怎么用

- 两个按钮：「开始笔记」和「截断」。
- 读到想记笔记的地方点「开始笔记」，笔记从当前页开始；觉得内容进入下一部分时点「截断」，笔记在当前页结束。截断只负责结束，不会自动开新笔记，不想记的部分可以空着。
- 「开始笔记」只能在没有笔记的页，或上一篇的截断页使用（章节不从新的一页开始时，两篇笔记共用这一页，编辑器上方可切换）。
- 页码范围写在笔记源码开头，直接修改即可微调（`12-` 表示尚未截断）：

  ```
  ---
  页码: 12-18
  ---
  ```

- 开启「跟随翻页」时，翻 PDF 会自动显示当前页对应的笔记。
- 删除的笔记进入废纸篓，可恢复。笔记里写 `[第 12 页](#p12)` 可生成跳转链接。

## 书签与文字层

- 书库列表显示每本书的文字状态（原生文字 / 已 OCR / 未 OCR）和书签数量，导入后自动检测。
- 阅读器中点「书签」（⌘B）打开书签栏：点击跳转，可添加、重命名、改页码、调整层级、删除或清空。
- 首次打开时导入 PDF 自带书签；之后的编辑保存在应用里，不改动 PDF 文件。

## 快捷键

| 按键 | 作用 |
|---|---|
| ← → / 空格 / PageUp PageDown | 翻页（触控板左右或上下滑动也可以） |
| Home / End | 第一页 / 最后一页 |
| ⌘E | 切换源码 / 预览 |
| ⌘\ | 显示 / 隐藏笔记栏 |
| ⌘B | 显示 / 隐藏书签栏 |
| 双指捏合 | 缩放 PDF |

## 数据位置

`~/Library/Application Support/Reader/library/`

- `library.json` — 书目、页数、阅读进度
- `books/<id>.pdf` — 导入时复制进来的 PDF
- `notes/<id>.json` — 该书的笔记与废纸篓
- `bookmarks/<id>.json` — 该书的书签

开发调试可用环境变量 `READER_DATA_DIR` 指向一个临时数据目录，`READER_PROD=1` 让未打包的应用加载 `dist/` 构建产物。
