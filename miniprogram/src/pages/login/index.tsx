/**
 * 登录页 —— 支持：
 *   1. 微信一键登录（Taro.login → backend /auth/wechat）— 生产主要流程
 *   2. 开发模式（admin@ftm.local 等邮箱密码）— DevTools 里没真微信调试时使用，
 *      仅开发构建可见（F-5：生产包严禁带开发者登录入口 + 明文默认密码）
 *
 * 微信登录注意：
 *   - 小程序里 Taro.getUserProfile 必须由用户主动点击按钮触发（不能在 useEffect 里自动调）
 *   - userInfo 拿到 nickName / avatarUrl 只是展示用，真身份 = openid（后端拿 code 换）
 */
import { useState } from 'react';
import Taro from '@tarojs/taro';
import { View, Text, Input } from '@tarojs/components';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../stores/auth';
import './index.scss';

// F-5：开发者登录 tab + 明文默认账号密码只在开发构建可见。Taro 编译时用 `dev:weapp`/`build:weapp`
// 各自设置 process.env.NODE_ENV=development/production（见 config/index.ts），效果等价于
// sales-web/src/pages/LoginPage.tsx 的 `import.meta.env.DEV` 门禁——公网上印默认密码等于开门。
const IS_DEV = process.env.NODE_ENV !== 'production';

export default function LoginPage() {
  const setAuth = useAuth((s) => s.setAuth);
  const [mode, setMode] = useState<'wechat' | 'email'>('wechat');
  // 默认值统一为空字符串：即使开发构建，也不在 state 初始值里带明文账号密码，
  // 避免被打进任何构建产物或调试快照里；demo 账号只在下方 disclaimer 文案里提示。
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  const loginWechat = async () => {
    setLoading(true);
    try {
      // 1. 调微信拿 code
      const { code } = await Taro.login();
      if (!code) throw new Error('wx.login 没拿到 code');

      // 2. （可选）获取用户昵称 + 头像 —— 必须用户主动点击触发
      let userInfo: { nickName?: string; avatarUrl?: string } | undefined;
      try {
        const profile = await Taro.getUserProfile({ desc: '用于完善会员资料' });
        userInfo = {
          nickName: profile.userInfo.nickName,
          avatarUrl: profile.userInfo.avatarUrl,
        };
      } catch {
        // 用户拒绝授权 — 忽略，用默认昵称
      }

      // 3. code 换 JWT
      const r = await api.wechatLogin(code, userInfo);
      setAuth(r.user, r.tokens);
      Taro.showToast({ title: '登录成功', icon: 'success' });
      setTimeout(() => Taro.navigateBack(), 800);
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : (e instanceof Error ? e.message : '登录失败');
      Taro.showModal({
        title: '微信登录失败',
        // 生产构建没有开发者登录入口，提示语跟着环境走，别指引客户去点一个不存在的 tab
        content: IS_DEV ? `${msg}\n\n开发中可切"开发者登录"用邮箱。` : msg,
        showCancel: false,
      });
    } finally {
      setLoading(false);
    }
  };

  const loginEmail = async () => {
    setLoading(true);
    try {
      const r = await api.devLogin(email, password);
      setAuth(r.user, r.tokens);
      Taro.showToast({ title: '登录成功', icon: 'success' });
      setTimeout(() => Taro.navigateBack(), 800);
    } catch (e) {
      Taro.showToast({
        title: e instanceof ApiError ? e.message : '登录失败',
        icon: 'none',
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <View className='login-page'>
      <View className='hero'>
        {/* F-4：前台消费者品牌统一为「椰岛假期」，「世途旅行」仅法律主体不对外露出 */}
        <Text className='title'>椰岛假期</Text>
        <Text className='sub'>澳门 ⇌ 岘港 · 越南专线</Text>
      </View>

      {/* F-5：开发者登录 tab 生产构建不渲染（不只是隐藏样式，DOM 里也不出现） */}
      {IS_DEV && (
        <View className='tabs'>
          <View
            className={`tab ${mode === 'wechat' ? 'active' : ''}`}
            onClick={() => setMode('wechat')}
          >
            微信登录
          </View>
          <View
            className={`tab ${mode === 'email' ? 'active' : ''}`}
            onClick={() => setMode('email')}
          >
            开发者登录
          </View>
        </View>
      )}

      {/* mode 只有在 IS_DEV 下才可能被切成 'email'（tab 不渲染就点不到），这里再兜底判一次
          IS_DEV，防止生产构建里任何残留状态把开发者登录面板渲染出来 */}
      {mode === 'wechat' || !IS_DEV ? (
        <View className='wechat-panel'>
          <Text className='panel-sub'>使用你的微信账号快速登录</Text>
          <View
            className={`btn-primary wechat-btn ${loading ? 'disabled' : ''}`}
            onClick={loading ? undefined : loginWechat}
          >
            {loading ? '登录中…' : '微信一键登录'}
          </View>
          <Text className='disclaimer'>
            登录即表示同意 用户协议 & 隐私政策
          </Text>
        </View>
      ) : (
        <View className='email-panel'>
          <Text className='label'>邮箱</Text>
          <Input className='input' value={email} onInput={(e) => setEmail(e.detail.value)} />
          <Text className='label'>密码</Text>
          <Input type='text' password className='input' value={password} onInput={(e) => setPassword(e.detail.value)} />
          <View className={`btn-primary ${loading ? 'disabled' : ''}`} onClick={loading ? undefined : loginEmail}>
            {loading ? '登录中…' : '登录'}
          </View>
          <Text className='disclaimer'>
            默认 demo 账号：customer@ftm.local / Password123!
          </Text>
        </View>
      )}
    </View>
  );
}
