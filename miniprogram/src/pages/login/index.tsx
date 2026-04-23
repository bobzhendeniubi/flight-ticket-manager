/**
 * 登录页 —— 支持：
 *   1. 微信一键登录（Taro.login → backend /auth/wechat）— 生产主要流程
 *   2. 开发模式（admin@ftm.local 等邮箱密码）— DevTools 里没真微信调试时使用
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

export default function LoginPage() {
  const setAuth = useAuth((s) => s.setAuth);
  const [mode, setMode] = useState<'wechat' | 'email'>('wechat');
  const [email, setEmail] = useState('customer@ftm.local');
  const [password, setPassword] = useState('Password123!');
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
        content: `${msg}\n\n开发中可切"开发者登录"用邮箱。`,
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
        <Text className='title'>世途旅行</Text>
        <Text className='sub'>澳门 ⇌ 岘港 · 越南专线</Text>
      </View>

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

      {mode === 'wechat' ? (
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
