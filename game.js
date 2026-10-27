import Main from './js/main';

const app = new Main();
// 调试钩子（devtools automation 观测用）：暴露游戏实例，无业务副作用
if (typeof GameGlobal !== 'undefined') GameGlobal.__app = app;

