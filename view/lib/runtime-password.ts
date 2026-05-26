/** 会话密码仅保存在本进程内存，供 vault 注册与 SSH 连接；不写入 localStorage */
const passwords = new Map<string, string>()

export function setRuntimePassword(profileId: string, password: string): void {
  passwords.set(profileId, password)
}

export function getRuntimePassword(profileId: string): string | undefined {
  return passwords.get(profileId)
}

export function clearRuntimePassword(profileId: string): void {
  passwords.delete(profileId)
}
