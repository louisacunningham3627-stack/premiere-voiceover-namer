# 赫朝 Premiere 录音命名器

Premiere Pro UXP 插件，将时间线录音在录制完成后自动整理为：

```text
项目名-<32位小写十六进制录音ID>.wav
```

示例：

```text
318最终版-7f3c9a2e4b1d48f0a6c1e8d2b9f04a77.wav
```

插件会同步修改磁盘文件名、Premiere ProjectItem 素材名、当前序列中的时间线片段名和媒体路径。当前构建版本是 `0.3.2`，目标 Premiere Pro `25.6+`，开发机版本为 `26.0.1`。

## 当前能力

- 打开面板后，已保存工程且有活动序列时会自动建立监听并把当前序列既有素材记作基线；不需要选择目录，也不用点击“开始监听”。
- 用户只需点击时间线音轨上的 Premiere 原生“画外音录制”麦克风。录音停止后，插件会识别新素材并自动处理。
- 自动候选必须同时满足可信采集位置和 Premiere 默认录音名：中文 `音频 N.wav` / `音频 N_N.wav`，或英文 `Audio N.wav` / `Audio N_N.wav`。普通 `music.wav`、自定义录音名和旧录音不会被自动改名。
- 自定义录音名、旧录音或自动监听期间错过的项目，应使用“扫描遗漏”；扫描会先展示文件名预览，再由用户确认批量处理。
- 同时使用音轨变化事件、导入完成事件和 `1.2s` 目录差异轮询；目录没有新 WAV 时不会反复遍历整条时间线，也不依赖 Computer Use。
- 等待文件大小和修改时间连续稳定后再改名，遇到 Windows 文件锁会退避重试；等待期间不记作处理失败。
- 每条新录音使用 UXP 可用的安全随机源生成一个 128 位 UUIDv4（其中 122 位为随机位），文件名去掉 UUID 连字符并统一为 32 位小写十六进制；不依赖 sidecar 计数器、工程副本、协作者或联网。
- 当前 UUID 格式是已经确定的录音身份。三种旧格式（`项目名-000123.wav`、`项目名-000123-yyyyMMdd-HHmmss.wav`、`项目名-A02-003-yyyyMMdd-HHmmss.wav`）只保护监听启动前的历史基线；监听启动后新产生的旧格式不会自动改名，只有在“扫描遗漏”预览中确认后才会升级为 UUID 并同步重链接。
- 目标文件已存在时绝不覆盖，插件重新生成录音 ID 并重试。两个离线工程副本分别录音后再合并，UUID 重合的概率极低但不是绝对数学保证；交接合并必须先检查同名文件的内容，不能让资源管理器的覆盖选项决定素材归属。
- 项目改名不会让已有 UUID 文件失去管理识别；录音 ID 是文件身份，项目名只是当前文件名前缀。
- 每条录音热路径只执行发现 WAV、等待稳定、生成 ID、磁盘改名、单个 ProjectItem 重链接，以及当前序列全部对应 TrackItem 的名称同步和轻量 sidecar 更新；不调用 `project.save()`，也不重写整个 `.prproj`。
- `0.3.0` 已经改过磁盘与 ProjectItem、但仍显示旧片段名的 UUID 录音，会在新版每次启动监听或切换序列后的首次扫描中执行轻量名称修复；该修复不再次改磁盘，也不再次重链接。
- 在工程旁写入 `<工程名>.voiceover-namer.json`，schema 4 只保存设置和最近处理记录，不保存也不依赖全局计数器。
- 会继续录音的每位协作者都应侧载 `0.3.2+`；复制旧版 sidecar 不能让旧计数命名获得跨副本唯一性。
- 接手人可以直接继续录音；不复制或合并计数器。若接手人使用旧版计数命名，新版插件会在监听到该新录音后立即升级为 UUID。若两份交接材料出现相同 UUID：内容相同则视为同一素材，内容不同则必须隔离其中一份、生成新 UUID 并只重链接对应工程，禁止覆盖。
- “扫描遗漏”会预览当前序列录音后再批量执行。
- 手动预览期间若源 WAV 的大小、时间或文件身份发生变化，该条会中止并要求重新扫描。
- 关闭或卸载面板时会解绑全局事件并取消尚未执行的手动批处理；正在进行的单条改名事务会先完整结束。
- 状态工作台会区分未连接、工程未保存、缺少或失效的目录、缺少序列、可开始、启动中、监听中、扫描中、处理中和出错，并只突出当前下一步。
- 四步处理链直接跟随发现 WAV、等待写入稳定、磁盘改名，以及 Premiere 重链接并同步时间线片段名的真实事务阶段。

## 面板怎么读

1. 打开并保存 Premiere 工程，打开要录音的活动序列；面板会自动待命。
2. 直接点击时间线音轨上的原生“画外音录制”麦克风并录音，停止后等待约 `3-4` 秒的文件稳定观察。
3. 插件按 `WAV → 项目唯一名 → 自动重链接并同步片段名` 处理，面板会显示发现、稳定、改名和链接/片段同步阶段。
4. 目录选择只是自动识别失败时的备用范围设置；不用为了开始录音而选择目录或点击开始按钮。
5. 文件名区域显示当前录音或命名示例，完成和失败结果同时保留在统计与最近活动中。

## 构建

本项目没有运行时或开发依赖，使用 Node.js 内置测试和构建脚本：

```powershell
npm test
npm run build
npm run check
```

只检查面板布局时，可运行不依赖 Premiere 的本地状态预览：

```powershell
npm run preview:panel
```

默认地址为 `http://127.0.0.1:4174/?state=ready`。`state` 支持 `disconnected`、`unsaved`、`no-folder`、`folder-error`、`no-sequence`、`ready`、`starting`、`listening`、`scanning`、`processing`、`loading` 和 `error`；处理与错误状态还可用 `stage=found|stable|rename|relink` 检查各阶段。预览直接复用生产版状态推导器，供人工检查布局与文字溢出，不能替代 UXP 或 Premiere 实机验收；端口被占用时可先设置 `PANEL_PREVIEW_PORT`。

可侧载的插件目录生成在：

```text
dist
```

## Windows 个人安装

Premiere 关闭时，在项目根目录运行：

```powershell
npm run check
npm run install:user
```

脚本会校验构建清单和逐文件 SHA-256，然后安装到 Premiere 26 实际扫描的用户级目录：

```text
%APPDATA%\Adobe\UXP\Plugins\External\com.hechao.premiere.voiceover-namer
```

旧版本会先移动到 `%APPDATA%\Adobe\UXP\PluginBackups`，安装失败时自动恢复。安装或更新后只需重新启动一次 Premiere，再打开“窗口 > UXP 插件 > 赫朝录音命名器”；连续录音期间不需要重启。协作者可在自己的 Windows 账户运行同一命令，不共享本机状态或计数器。

卸载也要求先关闭 Premiere。脚本不会直接删除插件，而是把它移出扫描目录并留下可恢复备份：

```powershell
npm run uninstall:user
```

开发机 Premiere Pro `26.0.1` 的 UXP 启动日志已确认插件 ID 可从用户级 fallback 目录被宿主发现。安装或更新 `0.3.2` 前必须先正常关闭 Premiere，完成后重新启动一次；连续录音期间不需要重启。真实录音、改名、重链接与时间线片段名同步仍须按 [运行验收清单](docs/运行验收清单.md) 在临时工程完成，全部通过前保持 `runtime_tested=false`。

## macOS 个人安装

macOS 使用同一套 UXP 源码和构建目录，不需要单独编译原生二进制。先在项目根目录确认 Node.js `>=20`，然后执行：

```bash
npm run check
npm run package:macos
```

打包产物位于 `outputs/macos/`，每个 macOS zip 自包含 `plugin/`、`安装-macOS.sh`、`卸载-macOS.sh`、`使用说明.md` 和 `SHA256SUMS.txt`，并附带 zip 的 SHA-256 清单。解压后接收方不需要 Node.js；在包目录直接运行安装脚本即可。源码仓库中的用户级安装脚本会校验 `dist`，先复制到临时目录并逐文件校验，再将旧版本移动到可恢复备份：

```bash
npm run install:user:macos
```

默认安装目录（Adobe UXP 用户级 External 侧载位置，属于本项目的个人侧载经验路径，不宣称为 Adobe 官方发布接口）为：

```text
~/Library/Application Support/Adobe/UXP/Plugins/External/com.hechao.premiere.voiceover-namer
```

脚本支持用 `BUILD_PATH` 和 `TARGET_ROOT` 覆盖构建目录与目标根目录；例如隔离测试可设置 `TARGET_ROOT="$TMPDIR/voiceover-uxp/External"`。如果检测到包含 `Adobe Premiere Pro` 的进程，脚本会停止并要求先退出；安装完成后启动一次 Premiere，再从“窗口 > UXP 插件”打开“赫朝录音命名器”。卸载使用：

```bash
npm run uninstall:user:macos
```

卸载不会直接删除插件，只会移动到 `~/Library/Application Support/Adobe/UXP/PluginBackups`。Mac 版本已覆盖 POSIX 路径、根目录和大小写敏感规则；macOS Premiere 的真实录音、重链接、权限和连续录音仍须按 [运行验收清单](docs/运行验收清单.md) 完成实机验收。

## UDT 开发侧载

1. 安装并打开 Adobe UXP Developer Tool。
2. 选择 `Add Plugin`，定位到 `dist\manifest.json`。
3. 在 UXP Developer Tool 中点击 `Load`。
4. 在 Premiere 中打开“窗口 > UXP 插件 > 赫朝录音命名器”。
5. 按面板顶部的当前提示完成工程保存和活动序列检查；面板会自动待命，随后直接点击时间线麦克风。

`plugin\manifest.json` 是构建输入，目录内不含运行脚本；不要直接侧载它。每次改动源码后重新执行 `npm run build`，始终侧载 `dist\manifest.json`。

UDT 用于开发期的 `Load & Watch` 和调试，不是本机个人安装的必要条件。Adobe 当前要求通过 Creative Cloud 和 Adobe ID 安装 UDT；没有账号时使用上面的用户级安装脚本。Premiere 内真实录音仍必须按 [运行验收清单](docs/运行验收清单.md) 完成后才能标记为通过。

## 安全边界

- 插件不能修改 Premiere 内置录音器写文件前的命名模板；它在录制完成后数秒内处理。
- UXP 公开接口不能在系统默认 WAV 落盘前拦截命名；插件只能在文件稳定后生成 UUID 并处理该文件。UUIDv4 的唯一性依赖 UXP 运行时提供的安全随机源，必须在目标 Premiere/UXP 版本实机确认可用，不宣称绝对零碰撞。
- 自动监听只处理可信采集位置中、启动监听后新出现在当前序列音轨上的 Premiere 默认录音名 WAV；普通或自定义名称请通过带预览的“扫描遗漏”处理。
- 同一 Premiere 素材即使在当前序列出现多次也只改磁盘和重链接一次，但会同步所有对应时间线片段名；只有同一磁盘路径关联到多个不同 ProjectItem 时才会保守跳过并记录错误。
- “扫描遗漏”会处理当前序列中尚未使用规范名称的 WAV，并在确认前展示预览；选择目录只是无法自动识别可信采集位置时的备用方式。
- 项目或序列切换时重新建立基线，避免把另一项目的既有素材当成新录音；项目副本之间不共享计数状态。
- UUID 只解决离线并行录音的命名身份；要做到合并后的最终目录绝不误链，交接流程还必须执行“同名同内容去重、同名不同内容隔离改 ID”的合并门禁。没有共享登记服务时，不能承诺数学意义上的绝对零碰撞。
- UXP 面板隐藏或销毁时会停止监听；重新打开并完成上下文读取后会重新自动待命，期间产生的录音可使用“扫描遗漏”恢复。
- 导入完成事件只在成功状态下加速扫描；即使该事件没有触发，目录轮询仍是兜底路径。
- 新 WAV 超过 60 秒仍未关联到当前序列时会警告并退避到每 10 秒探测，5 分钟后每 30 秒探测；导入、音轨或序列事件会立即唤醒，不会永久忽略。
- 插件不会在每条录音后保存 `.prproj`，也没有“处理后自动保存工程”设置。按需使用正常的 `Ctrl+S`、Premiere 自动保存或关闭项目时的保存提示，把多条录音的路径和素材名一次性持久化。
- 在正常保存前发生崩溃或强制退出时，磁盘文件可能已经改名，但上次工程快照仍保存旧媒体路径；重开后可能看到路径过时或素材离线。此时先按目录扫描/重新链接流程恢复，未来可增加恢复 journal 提高崩溃恢复能力。

## 参考

- [Adobe Premiere Pro UXP samples](https://github.com/AdobeDocs/uxp-premiere-pro-samples)
- [Adobe Premiere Pro TypeScript definitions](https://github.com/adobe/premierepro-types)
- [ReNaaaame](https://github.com/asyura888/ReNaaaame)（MIT；仅参考其公开的重命名/重链接事务思路，本项目未复制其源码）
