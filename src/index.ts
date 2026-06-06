import { Context, Schema, Logger, Session } from 'koishi'
import {} from "koishi-plugin-adapter-onebot";

export const name = 'onebot-verifier'
export const inject = { optional: ['database'] }
export const usage = `
<div style="border-radius: 10px; border: 1px solid #ddd; padding: 16px; margin-bottom: 20px; box-shadow: 0 2px 5px rgba(0,0,0,0.1);">
  <h2 style="margin-top: 0; color: #4a6ee0;">📌 插件说明</h2>
  <p>📖 <strong>使用文档</strong>：请点击左上角的 <strong>插件主页</strong> 查看插件使用文档</p>
  <p>🔍 <strong>更多插件</strong>：可访问 <a href="https://github.com/YisRime" style="color:#4a6ee0;text-decoration:none;">苡淞的 GitHub</a> 查看本人的所有插件</p>
</div>
<div style="border-radius: 10px; border: 1px solid #ddd; padding: 16px; margin-bottom: 20px; box-shadow: 0 2px 5px rgba(0,0,0,0.1);">
  <h2 style="margin-top: 0; color: #e0574a;">❤️ 支持与反馈</h2>
  <p>🌟 喜欢这个插件？请在 <a href="https://github.com/YisRime" style="color:#e0574a;text-decoration:none;">GitHub</a> 上给我一个 Star！</p>
  <p>🐛 遇到问题？请通过 <strong>Issues</strong> 提交反馈，或加入 QQ 群 <a href="https://qm.qq.com/q/PdLMx9Jowq" style="color:#e0574a;text-decoration:none;"><strong>855571375</strong></a> 进行交流</p>
</div>
`

type RequestType = 'friend' | 'guild' | 'member'

interface UserStats {
  user_id: number
  qqLevel?: number
}

interface GroupStats {
  group_id: number
  group_name: string
  member_count: number
  max_member_count: number
}

interface VerifyTask {
  session: Session;
  kind: RequestType;
  messages: string[];
  timer?: NodeJS.Timeout;
}

export interface Config {
  notifyTarget?: string
  debugMode?: boolean
  timeout?: number
  timeoutAction?: 'accept' | 'reject'
  friendLevel?: number
  friendRegex?: string
  minMembers?: number
  maxCapacity?: number
  verifyMode?: 'accept' | 'reject' | 'manual'
  verifyRules?: {
    guildId: string;
    keyword?: string;
    minLevel?: number;
    action?: 'accept' | 'reject'
  }[]
}

export const Config: Schema<Config> = Schema.intersect([
  Schema.object({
    notifyTarget: Schema.string().description('通知目标(guild/private:number)').required(),
    debugMode: Schema.boolean().description('输出调试日志').default(false),
  }).description('基础配置'),
  Schema.object({
    timeout: Schema.number().description('请求超时时长').default(360).min(0),
    timeoutAction: Schema.union([
      Schema.const('accept').description('同意'),
      Schema.const('reject').description('拒绝'),
    ]).description('默认超时操作').default('accept'),
    friendLevel: Schema.number().description('最低好友等级').default(-1).min(-1).max(256),
    friendRegex: Schema.string().description('好友验证正则'),
    minMembers: Schema.number().description('最低群成员数').default(-1).min(-1).max(3000),
    maxCapacity: Schema.number().description('最低受邀容量').default(-1).min(-1).max(3000),
  }).description('好友邀群配置'),
  Schema.object({
    verifyMode: Schema.union([
      Schema.const('accept').description('同意'),
      Schema.const('reject').description('拒绝'),
      Schema.const('manual').description('手动'),
    ]).description('处理模式').default('manual'),
    verifyRules: Schema.array(Schema.object({
      guildId: Schema.string().description('群号').required(),
      keyword: Schema.string().description('正则'),
      minLevel: Schema.number().description('等级').default(-1),
      action: Schema.union([
        Schema.const('accept').description('同意'),
        Schema.const('reject').description('拒绝'),
      ]).description('操作'),
    })).description('加群验证配置').role('table'),
  }).description('加群请求配置')
])

export function apply(ctx: Context, config: Config = {}) {
  const logger = new Logger('onebot-verifier');
  const activeTasks = new Map<string, VerifyTask>();

  const executeAction = async (session: Session, kind: RequestType, pass: boolean, reason = '', remark = ''): Promise<boolean> => {
    try {
      const eventData = session.event?._data || {};
      if (config.debugMode) logger.info(`[执行操作] 类型:${kind} 结果:${pass ? '同意' : '拒绝'} 原因:${reason || '无'}`);
      if (!pass && kind === 'guild' && session.guildId && (session.event?.type === 'guild-added' || eventData.notice_type === 'group_increase')) {
        if (reason) {
          try { await session.bot.sendMessage(session.guildId, `${reason}，将退出该群`); }
          catch (error) { logger.warn(`发送退群通知失败: ${error}`); }
        }
        await session.onebot?.setGroupLeave(session.guildId, false);
        return true;
      }
      if (!eventData.flag || !session.onebot) return false;
      if (kind === 'friend') await session.onebot.setFriendAddRequest(eventData.flag, pass, remark);
      else await session.onebot.setGroupAddRequest(eventData.flag, eventData.sub_type ?? 'add', pass, pass ? '' : reason);
      return true;
    } catch (error) {
      logger.error(`操作失败: ${error}`);
      return false;
    }
  };

  const sendNotice = async (session: Session, kind: RequestType, status: 'auto_pass' | 'auto_reject' | 'waiting' = 'waiting'): Promise<string[]> => {
    const notifyConfig = config.notifyTarget || '';
    if (!notifyConfig) return [];
    const [targetType, targetId] = notifyConfig.split(':');
    if (!targetId || (targetType !== 'guild' && targetType !== 'private')) return [];
    try {
      const eventData = session.event?._data || {};
      const userInfo = session.userId ? await session.bot.getUser?.(session.userId)?.catch(() => null) : null;
      const groupInfo = (kind !== 'friend' && session.guildId) ? await session.bot.getGuild?.(session.guildId)?.catch(() => null) : null;
      const adminInfo = eventData.operator_id && session.userId && eventData.operator_id !== session.userId
        ? await session.bot.getUser?.(eventData.operator_id)?.catch(() => null) : null;
      const infoLines = [];
      if (userInfo?.avatar) infoLines.push(`<image url="${userInfo.avatar}"/>`);
      const typeName = kind === 'friend' ? '好友申请' : kind === 'member' ? '加群请求' : '群组邀请';
      const statusText = status === 'auto_pass' ? '[自动通过]' : status === 'auto_reject' ? '[自动拒绝]' : '[等待处理]';
      infoLines.push(`类型：${typeName} ${statusText}`);
      if (kind !== 'guild' || session.userId !== session.selfId) infoLines.push(`用户：${userInfo?.name || session.userId}${session.userId ? `(${session.userId})` : ''}`);
      if (adminInfo) infoLines.push(`管理：${adminInfo.name ? `${adminInfo.name}(${eventData.operator_id})` : eventData.operator_id}`);
      if (groupInfo) infoLines.push(`群组：${groupInfo.name ? `${groupInfo.name}(${session.guildId})` : session.guildId}`);
      if (eventData.comment) infoLines.push(`验证信息：${eventData.comment}`);
      const content = infoLines.join('\n');
      return await (targetType === 'private' ? session.bot.sendPrivateMessage(targetId, content) : session.bot.sendMessage(targetId, content)) || [];
    } catch (error) {
      logger.error(`通知失败: ${error}`);
      return [];
    }
  };

  const checkCriteria = async (session: Session, kind: RequestType): Promise<boolean | string> => {
    const rawText = session.event?._data?.comment || '';
    const cleanLines = rawText.split(/[\r\n]+/)
      .map((s: string) => s.trim()).filter((s: string) => /^(回答)[:：]/i.test(s)).map((s: string) => s.replace(/^(回答)[:：]\s*/i, ''));
    const verifyText = cleanLines.length > 0 ? cleanLines.join('\n') : rawText;
    if (kind === 'friend') {
      try {
        if (config.friendRegex && new RegExp(config.friendRegex, 'i').test(verifyText)) {
          if (config.debugMode) logger.info(`[规则匹配] 好友检查: ${config.friendRegex}`);
          return true;
        }
        const limitLevel = config.friendLevel ?? -1;
        if (limitLevel >= 0 && session.onebot && session.userId) {
          const stats = await session.onebot.getStrangerInfo(session.userId, true) as UserStats;
          const isPassed = (stats.qqLevel ?? 0) >= limitLevel;
          if (config.debugMode) logger.info(`[规则判定] 等级检查: ${stats.qqLevel} > ${limitLevel} = ${isPassed}`);
          if (!isPassed) return `QQ 等级低于 ${limitLevel} 级`;
          return true;
        }
      } catch { return false; }
      return false;
    }
    if (kind === 'guild') {
      try {
        const userData = session.userId ? await ctx.database.getUser(session.platform, session.userId) : null;
        if (userData && userData.authority > 1) {
          if (config.debugMode) logger.info(`[规则匹配] : ${userData.authority}`);
          return true;
        }
      } catch {}
      if (session.onebot && session.guildId && ((config.minMembers ?? -1) >= 0 || (config.maxCapacity ?? -1) >= 0)) {
        try {
          const stats = await session.onebot.getGroupInfo(session.guildId, true) as GroupStats;
          if ((config.minMembers ?? -1) >= 0 && stats.member_count < (config.minMembers ?? 0)) {
            if (config.debugMode) logger.info(`[规则判定] 成员检查: ${stats.member_count} < ${config.minMembers}`);
            return `群成员不足 ${config.minMembers} 人`;
          }
          if ((config.maxCapacity ?? -1) >= 0 && stats.max_member_count < (config.maxCapacity ?? 0)) {
            if (config.debugMode) logger.info(`[规则判定] 容量检查: ${stats.max_member_count} < ${config.maxCapacity}`);
            return `群容量不足 ${config.maxCapacity} 人`;
          }
          return true;
        } catch { return false; }
      }
      return false;
    }
    return false;
  };

  const setupManual = async (session: Session, kind: RequestType) => {
    const msgIds = await sendNotice(session, kind, 'waiting');
    if (!msgIds?.length) return;
    const task: VerifyTask = { session, kind, messages: msgIds };
    msgIds.forEach(id => activeTasks.set(id, task));
    const waitMinutes = config.timeout ?? 0;
    if (waitMinutes > 0) {
      task.timer = setTimeout(async () => {
        if (!activeTasks.has(msgIds[0])) return;
        msgIds.forEach(id => activeTasks.delete(id));
        const action = kind === 'member' ? config.verifyMode : config.timeoutAction;
        if (action === 'manual' || !action) return;
        const isPass = action === 'accept';
        await executeAction(session, kind, isPass, isPass ? '' : '等待人工超时，自动拒绝');
        const notifyConfig = config.notifyTarget || '';
        const [targetType, targetId] = notifyConfig.split(':');
        if (targetId) {
          const statusText = `已自动${isPass ? '通过' : '拒绝'}该请求`;
          await (targetType === 'private' ? session.bot.sendPrivateMessage(targetId, statusText) : session.bot.sendMessage(targetId, statusText));
        }
      }, waitMinutes * 60000);
    }
  };

  const handleEvent = async (session: Session, kind: RequestType) => {
    try {
      if (config.debugMode) logger.info(`[收到请求] 类型:${kind} 数据:${JSON.stringify(session.event?._data || {})}`);
      if (kind === 'member') {
        const rule = config.verifyRules?.find(r => r.guildId === session.guildId);
        if (rule) {
          const rawText = session.event?._data?.comment || '';
          const stats = (rule.minLevel ?? -1) >= 0 && session.onebot && session.userId
            ? await session.onebot.getStrangerInfo(session.userId, true).catch(() => ({})) as UserStats : null;
          const keywordMatch = !rule.keyword || new RegExp(rule.keyword, 'i').test(rawText);
          const levelMatch = !stats || (stats.qqLevel ?? 0) >= rule.minLevel!;
          const isMatch = keywordMatch && levelMatch;
          if (config.debugMode) logger.info(`[规则判定] ${rule.guildId}: 关键词=${keywordMatch}, 等级=${levelMatch}, 结果=${isMatch}`);
          if (isMatch && rule.action) {
            const isApprove = rule.action === 'accept';
            await executeAction(session, kind, isApprove, isApprove ? '' : '命中拒绝规则，自动拒绝');
            await sendNotice(session, kind, isApprove ? 'auto_pass' : 'auto_reject');
            return;
          }
        }
        return await setupManual(session, kind);
      }
      const verdict = await checkCriteria(session, kind);
      if (verdict === true) {
        await executeAction(session, kind, true);
        await sendNotice(session, kind, 'auto_pass');
      } else if (typeof verdict === 'string') {
        await executeAction(session, kind, false, verdict);
        await sendNotice(session, kind, 'auto_reject');
      } else {
        await setupManual(session, kind);
      }
    } catch (error) { logger.error(`处理失败: ${error}`); }
  };

  const hookEvent = (kind: RequestType) => async (session: Session) => {
    const eventData = session.event?._data || {};
    session.userId = eventData.user_id;
    if (kind !== 'friend') session.guildId = eventData.group_id;
    await handleEvent(session, kind);
  };

  ctx.on('friend-request', hookEvent('friend'));
  ctx.on('guild-request', hookEvent('guild'));
  ctx.on('guild-member-request', hookEvent('member'));
  ctx.on('guild-added', hookEvent('guild'));

  ctx.middleware(async (session, next) => {
    if (typeof session.content !== 'string' || !session.quote?.id) return next();
    const activeTask = activeTasks.get(session.quote.id);
    if (!activeTask) return next();
    const notifyConfig = config.notifyTarget || '';
    const [targetType, targetId] = notifyConfig.split(':');
    if (targetType === 'private' ? session.userId !== targetId : session.guildId !== targetId) return next();
    const input = session.content.replace(/<(quote|at)\s+[^>]*\/>/gi, '').trim();
    const cmdMatch = input.match(/^(y|n|通过|拒绝)(?:\s+(.*))?$/);
    if (!cmdMatch) return next();
    if (activeTask.timer) clearTimeout(activeTask.timer);
    activeTask.messages.forEach(msg => activeTasks.delete(msg));
    const isApprove = cmdMatch[1] === 'y' || cmdMatch[1] === '通过';
    const extraInfo = cmdMatch[2]?.trim() || '';
    if (config.debugMode) logger.info(`[人工回复] 用户 ${session.userId} 回复: ${cmdMatch[1]} 备注: ${extraInfo}`);
    const isSuccess = await executeAction(activeTask.session, activeTask.kind, isApprove, isApprove ? '' : extraInfo, isApprove && activeTask.kind === 'friend' ? extraInfo : '');
    const replyText = isSuccess ? `已${isApprove ? '通过' : '拒绝'}该请求` : `处理请求失败`;
    await (targetType === 'private' ? session.bot.sendPrivateMessage(targetId, replyText) : session.bot.sendMessage(targetId, replyText));
  });
}
