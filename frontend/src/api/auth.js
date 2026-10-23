import { api } from './client.js';

export const login = (email, password) =>
  api('/auth/login', { method: 'POST', body: { email, password }, skipAuthRedirect: true });

export const logout = () => api('/auth/logout', { method: 'POST', skipAuthRedirect: true });

export const me = () => api('/auth/me', { skipAuthRedirect: true });
