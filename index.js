/**
 * 兼容入口：真正的主体在 ./host.js。
 *
 * 为什么拆成两个文件：DSH 宿主进程只在**装载插件那一刻** import 一次入口模块，
 * 之后 `plugin_manager set_plugin enabled=false/true` 只重放配置、不会重新 import
 * （实测：往入口里加自检落盘代码 + 改名 + 重载，自检文件始终不出现）。
 * 把入口换成新文件名（`host.js`）可以让**下一次启动**必定读到当前代码，
 * 这个文件则保证旧名字仍然可用，两个入口不会漂移。
 */
export * from './host.js';
