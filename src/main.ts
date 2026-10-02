import { createApp } from 'vue';
import Varlet from '@varlet/ui';
import '@varlet/ui/es/style';
import './style.css';
import App from './App.vue';
import { initStore } from './store';

// 首次打开时迁移旧数据 / 重放账本；失败会在界面上提示并允许重试。
initStore();

createApp(App).use(Varlet).mount('#app');

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // The app remains usable online when service-worker registration is unavailable.
    });
  });
}
