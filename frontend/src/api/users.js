import { api } from './client.js';

export const listUsers = ({ includeInactive = true } = {}) => api(`/users?includeInactive=${includeInactive}`);
export const createUser = (body) => api('/users', { method: 'POST', body });
export const updateUser = (id, body) => api(`/users/${id}`, { method: 'PATCH', body });
export const deactivateUser = (id) => api(`/users/${id}`, { method: 'DELETE' });

export const addAlias = (userId, alias) => api(`/users/${userId}/aliases`, { method: 'POST', body: { alias } });
export const removeAlias = (userId, aliasId) => api(`/users/${userId}/aliases/${aliasId}`, { method: 'DELETE' });
