import { api } from './client.js';

// The signed-in user's own tasks (employee portal). The server scopes everything to the session.
export const listMyTasks = () => api('/me/tasks');
export const getMyTask = (id) => api(`/me/tasks/${id}`);
/** `fromStatus` lets the server refuse the change if the task moved on in the meantime. */
export const updateMyTaskStatus = (id, status, fromStatus) =>
  api(`/me/tasks/${id}/status`, { method: 'PATCH', body: { status, fromStatus } });
