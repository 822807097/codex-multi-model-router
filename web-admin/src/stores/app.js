import { defineStore } from 'pinia';
import { restartRouterService } from '../api/system.js';
import { ElNotification } from 'element-plus';

export const useAppStore = defineStore('app', {
  state: () => ({
    restarting: false,
    restartTimeLeft: 0,
    routerStatus: 'active',
    // 网关离线（请求拦截器置位）：Topbar 横幅提示重连中
    gatewayOffline: false,
  }),
  actions: {
    markOffline() {
      this.gatewayOffline = true;
    },
    markOnline() {
      if (this.gatewayOffline) {
        this.gatewayOffline = false;
        ElNotification({
          title: '网关已恢复',
          message: '与路由服务的连接已重新建立',
          type: 'success',
          duration: 2500,
        });
      }
    },
    async restartService() {
      this.restarting = true;
      this.restartTimeLeft = 3;
      try {
        await restartRouterService();
        ElNotification({
          title: '服务重启中',
          message: '正在重启 Codex 路由进程，3 秒后自动重连...',
          type: 'info',
          duration: 3000,
        });
        const timer = setInterval(() => {
          this.restartTimeLeft--;
          if (this.restartTimeLeft <= 0) {
            clearInterval(timer);
            this.restarting = false;
            location.reload();
          }
        }, 1000);
      } catch (err) {
        this.restarting = false;
      }
    },
  },
});
