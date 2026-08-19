import { createApp } from 'vue';
import { createPinia } from 'pinia';
import ElementPlus from 'element-plus';
import * as ElementPlusIconsVue from '@element-plus/icons-vue';
import 'element-plus/dist/index.css';

import App from './App.vue';
import router from './router/index.js';
// 设计 Token 必须先于其他样式导入，Tailwind 语义类与 EP 变量均引用其中的 CSS 变量
import './styles/tokens.css';
import './styles/main.css';
import { useAppStore } from './stores/app.js';
import { bindAppStore } from './api/request.js';

const app = createApp(App);

for (const [key, component] of Object.entries(ElementPlusIconsVue)) {
  app.component(key, component);
}

const pinia = createPinia();
app.use(pinia);
// axios 拦截器需要读写全局离线状态（Pinia 就绪后绑定，避免循环依赖）
bindAppStore(useAppStore(pinia));
app.use(router);
app.use(ElementPlus);

app.mount('#app');
