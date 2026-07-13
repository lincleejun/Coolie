当前我想做一个我想要的编码辅助工具叫Coolie
我有一些可以参考的内容，详细信息见 refs/README.MD。

我的设想中：整体是做coding agent的二次环境脚手架，我不做coding agent本身，因为我们日常开发中，每个人都会有多个coding agent，因为quota、模型强弱、偏好等因素会使用各种coding agent，我们统称为 coding engine。
对于所有引擎的抽象和使用可以参考 opencode，但是优先使用集成tty或者镶嵌 tmux(https://github.com/tmux/tmux/wiki)进行使用coding agent，而不是自渲染

Coolie的定位就是为这些开发提供环境，类似于cursor又没那么重，主要是为我个人服务。
UI可以参考refs中conductor、cursor部分，
逻辑可以参考 refs中kobe的实现
对于coding engine部分，我们优先集成tty（如：https://github.com/ghostty-org/ghostty）和tmux，内置使用claude、codex自身对tmux的支持，完成UI渲染，其次才接受无头模式自行渲染。

架构：
采用CS结构，前端UI是client，可以是真实conductor类似的UI，也可以是terminal 类似的tui（如：kobe），同时也支持cli来操作server。
client： 采用react + tauri
server：typescript + 依赖注入（参考 opencode）
cli： typescript

一句话描述 coolie：coolie是你干净的开发开发环境脚手架， = repo + branch
分支、仓库、workspace的定义参考 conductor
也可以定义为kobe的task = git worktree + tmux session + branch


右侧的UI中
- 支持查看当前工程内的所有内容， 和diffs， 因为我工作在某个分支，则可能存在diff，方便做code review，也可以参考
- 也可以集成terminal的接入，例如iterm2 + oh-my-zsh


底部输入框
- 参考refs/input.png ，如模型选择、effort选择、输入、附件等等


快捷键支持
一定要支持丰富的快捷键，并且输入框要支持macos 原生的快捷键，例如：ctrl + a， ctrl + e等等

平台：
优先：macos，其次跨平台


注意：我自己不做coding agent， 我只做coding agent的伴侣， 符合我个人风格的伴侣