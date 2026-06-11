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

type RequestType = 'friend' | 'guild' | 'member' | 'removed'

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
  specialMode?: 'vote';
  voteTarget?: { yes: number, no: number };
  votes?: { yes: Set<string>, no: Set<string> };
}

export interface Config {
  notifyTarget?: string
  debugMode?: boolean
  kickBan?: boolean
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
  voteRatio?: string
  syncNotify?: boolean
  specialRules?: {
    guildId: string;
    mode: 'vote';
  }[]
}

export const Config: Schema<Config> = Schema.intersect([
  Schema.object({
    notifyTarget: Schema.string().description('通知目标(guild/private:number)').required(),
    debugMode: Schema.boolean().description('输出调试日志').default(false),
    kickBan: Schema.boolean().description('被踢自动处理').default(false),
  }).description('基础配置'),
  Schema.object({
    timeout: Schema.number().description('请求超时时长').default(360).min(0),
    timeoutAction: Schema.union([
      Schema.const('accept').description('同意'),
      Schema.const('reject').description('拒绝'),
    ]).description('默认超时操作').default('accept'),
    friendLevel: Schema.number().description('最低好友等级').default(0).min(0).max(256),
    friendRegex: Schema.string().description('好友验证正则'),
    minMembers: Schema.number().description('最低群成员数').default(0).min(0).max(3000),
    maxCapacity: Schema.number().description('最低受邀容量').default(0).min(0).max(3000),
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
      minLevel: Schema.number().description('等级').default(0),
      action: Schema.union([
        Schema.const('accept').description('同意'),
        Schema.const('reject').description('拒绝'),
      ]).description('操作'),
    })).description('加群验证配置').role('table'),
  }).description('加群请求配置'),
  Schema.object({
    syncNotify: Schema.boolean().description('同步通知目标').default(true),
    specialRules: Schema.array(Schema.object({
      guildId: Schema.string().description('群号').required(),
      mode: Schema.union([
        Schema.const('vote').description('投票'),
      ]).description('模式').default('vote'),
    })).description('群组特殊配置').role('table'),
    voteRatio: Schema.string().description('投票比例').default('3:2'),
  }).description('特殊验证配置')
])

export function apply(ctx: Context, config: Config = {}) {
  const logger = new Logger('onebot-verifier');
  const activeTasks = new Map<string, VerifyTask>();
  const inviterMap = new Map<string, string>();

  const getComment = (comment?: string) => {
    if (!comment) return '';
    const lines = comment.split(/[\r\n]+/).map(s => s.trim());
    const answers = lines.filter(s => /^(回答|答案)[:：]/i.test(s)).map(s => s.replace(/^(回答|答案)[:：]\s*/i, ''));
    return answers.length > 0 ? answers.join('\n') : comment;
  };

  const executeAction = async (session: Session, kind: RequestType, pass: boolean, reason = '', remark = ''): Promise<boolean> => {
    try {
      const eventData = session.event?._data || {};
      if (config.debugMode) logger.info(`[操作] 类型:${kind} 结果:${pass ? '同意' : '拒绝'} 原因:${reason || '无'}`);
      if (pass && kind === 'guild' && session.guildId && session.userId) inviterMap.set(session.guildId, session.userId);
      if (!pass && kind === 'guild' && session.guildId && (session.event?.type === 'guild-added' || eventData.notice_type === 'group_increase')) {
        if (reason) await session.bot?.sendMessage(session.guildId, `${reason}，将退出该群`).catch(() => {});
        await session.onebot?.setGroupLeave(session.guildId, false);
        if (config.debugMode) logger.info(`[操作] 退出群组: ${session.guildId}`);
        return true;
      }
      const flag = eventData.flag;
      if (!flag || !session.onebot) return false;
      if (kind === 'friend') {
        await session.onebot.setFriendAddRequest(flag, pass, remark);
      } else {
        await session.onebot.setGroupAddRequest(flag, eventData.sub_type ?? 'add', pass, pass ? '' : reason);
      }
      return true;
    } catch (error) {
      logger.error(`操作失败: ${error}`);
      return false;
    }
  };

  const sendNotice = async (session: Session, kind: RequestType, status: 'auto_pass' | 'auto_reject' | 'waiting' = 'waiting'): Promise<string[]> => {
    const notifyConfig = config.notifyTarget || '';
    const [targetType, targetId] = notifyConfig.split(':');
    if (!targetId || !session.bot) return [];
    try {
      const eventData = session.event?._data || {};
      const userInfo = session.userId ? await session.bot.getUser?.(session.userId).catch(() => null) : null;
      const groupInfo = (kind !== 'friend' && session.guildId) ? await session.bot.getGuild?.(session.guildId).catch(() => null) : null;
      const adminId = String(eventData.operator_id || session.event?.operator?.id || '');
      const adminInfo = (adminId && adminId !== session.userId) ? await session.bot.getUser?.(adminId).catch(() => null) : null;
      const typeMap = { friend: '好友申请', member: '加群请求', guild: '群组邀请', removed: eventData.sub_type === 'kick_me' ? '移出群组' : '退出群组' };
      const statusMap = { auto_pass: ' [自动通过]', auto_reject: ' [自动拒绝]', waiting: ' [等待处理]' };
      const infoLines = [];
      if (userInfo?.avatar) infoLines.push(`<image url="${userInfo.avatar}"/>`);
      infoLines.push(`类型：${typeMap[kind] || '未知'}${kind === 'removed' ? (eventData.sub_type === 'kick_me' && config.kickBan ? ' [自动清理]' : '') : statusMap[status]}`);
      if ((kind !== 'guild' && kind !== 'removed') || (session.userId && session.userId !== session.selfId)) infoLines.push(`用户：${userInfo?.name || session.userId}${session.userId ? `(${session.userId})` : ''}`);
      if (adminId) infoLines.push(`管理：${adminInfo?.name ? `${adminInfo.name}(${adminId})` : adminId}`);
      if (session.guildId) infoLines.push(`群组：${groupInfo?.name ? `${groupInfo.name}(${session.guildId})` : session.guildId}`);
      if (eventData.comment) infoLines.push(`验证信息：${eventData.comment}`);
      if (status === 'waiting') infoLines.push(`使用"y/n"回复本消息，以同意/拒绝该请求`);
      const content = infoLines.join('\n');
      const msgIds = await (targetType === 'private' ? session.bot.sendPrivateMessage(targetId, content) : session.bot.sendMessage(targetId, content)) || [];
      return msgIds;
    } catch (error) {
      logger.error(`通知失败: ${error}`);
      return [];
    }
  };

  const handleSpecialRule = async (session: Session, kind: RequestType): Promise<boolean> => {
    if (kind !== 'member' || !config.specialRules || config.specialRules.length === 0) return false;
    const rule = config.specialRules.find(r => String(r.guildId) === String(session.guildId));
    if (!rule) return false;
    if (rule.mode === 'vote') {
      const [yesStr, noStr] = config.voteRatio!.split(':');
      const targetYes = parseInt(yesStr) || 0;
      const targetNo = parseInt(noStr) || 0;
      let msgIds: string[] = [];
      if (config.syncNotify !== false) msgIds = await sendNotice(session, kind, 'waiting');
      if (msgIds.length > 0) {
        const task: VerifyTask = { session, kind, messages: msgIds, specialMode: 'vote', voteTarget: { yes: targetYes, no: targetNo }, votes: { yes: new Set(), no: new Set() } };
        msgIds.forEach(id => activeTasks.set(id, task));
      }
      return true;
    }
    return false;
  };

  const setupManual = async (session: Session, kind: RequestType) => {
    const waitMinutes = config.timeout ?? 0;
    const action = kind === 'member' ? config.verifyMode : config.timeoutAction;
    if (waitMinutes > 0) {
      const msgIds = await sendNotice(session, kind, 'waiting');
      if (!msgIds?.length) return;
      const task: VerifyTask = { session, kind, messages: msgIds };
      msgIds.forEach(id => activeTasks.set(id, task));
      task.timer = setTimeout(async () => {
        if (!activeTasks.has(msgIds[0])) return;
        msgIds.forEach(id => activeTasks.delete(id));
        const finalAction = kind === 'member' ? (config.verifyMode ?? 'manual') : (config.timeoutAction ?? 'accept');
        if (finalAction === 'manual') return;
        const isPass = finalAction === 'accept';
        await executeAction(session, kind, isPass, isPass ? '' : '等待超时，自动拒绝');
        const [targetType, targetId] = (config.notifyTarget || '').split(':');
        if (targetId && session.bot) {
          const statusText = `已自动${isPass ? '通过' : '拒绝'}该请求`;
          await (targetType === 'private' ? session.bot.sendPrivateMessage(targetId, statusText) : session.bot.sendMessage(targetId, statusText)).catch(() => {});
        }
        if (config.debugMode) logger.info(`[操作] 等待超时，默认${isPass ? '通过' : '拒绝'}`);
      }, waitMinutes * 60000);
    } else {
      if (action === 'manual' || !action) return await sendNotice(session, kind, 'waiting');
      const isPass = action === 'accept';
      await executeAction(session, kind, isPass, '等待超时，自动处理');
      await sendNotice(session, kind, isPass ? 'auto_pass' : 'auto_reject');
      if (config.debugMode) logger.info(`[操作] 无需等待，默认${isPass ? '通过' : '拒绝'}`);
    }
  };

  const hookEvent = (kind: RequestType) => async (session: Session) => {
    const eventData = session.event?._data || {};
    if (eventData.user_id) session.userId = String(eventData.user_id);
    if (eventData.group_id) session.guildId = String(eventData.group_id);
    try {
      if (config.debugMode) logger.info(`[收到请求] 类型: ${kind} 数据: ${JSON.stringify(session.event?._data || {})}`);
      const verifyText = getComment(session.event?._data?.comment);
      if (kind === 'member') {
        if (await handleSpecialRule(session, kind)) return;
        const rules = config.verifyRules?.filter(r => String(r.guildId) === String(session.guildId)) || [];
        for (const rule of rules) {
          const minL = rule.minLevel ?? 0;
          const stats = (minL > 0 && session.onebot && session.userId) ? await session.onebot.getStrangerInfo(session.userId, true).catch(() => ({})) as UserStats : null;
          const keywordMatch = !rule.keyword || new RegExp(rule.keyword, 'i').test(verifyText);
          const levelMatch = !stats || (stats.qqLevel ?? 0) >= minL;
          if (config.debugMode) {
            if (rule.keyword) logger.info(`[加群验证] 内容 "${verifyText}" ${keywordMatch ? '匹配' : '不匹配'}正则 "${rule.keyword}"`);
            if (stats) logger.info(`[加群验证] 用户 ${session.userId} 等级 ${stats.qqLevel ?? 0}${levelMatch ? '>' : '<'}${minL}`);
          }
          if (keywordMatch && levelMatch && rule.action) {
            const isApprove = rule.action === 'accept';
            await executeAction(session, kind, isApprove, isApprove ? '' : '命中规则，自动拒绝');
            await sendNotice(session, kind, isApprove ? 'auto_pass' : 'auto_reject');
            return;
          }
        }
        if (config.verifyMode && config.verifyMode !== 'manual') {
          const isApprove = config.verifyMode === 'accept';
          await executeAction(session, kind, isApprove, '等待超时，自动处理');
          await sendNotice(session, kind, isApprove ? 'auto_pass' : 'auto_reject');
          return;
        }
        return await setupManual(session, kind);
      }
      let verdict: boolean | string = false;
      if (kind === 'friend') {
        if (config.friendRegex) {
          const isRegexMatched = new RegExp(config.friendRegex, 'i').test(verifyText);
          if (config.debugMode) logger.info(`[好友验证] 内容 "${verifyText}" ${isRegexMatched ? '匹配' : '不匹配'}正则 "${config.friendRegex}" `);
          if (isRegexMatched) verdict = true;
        }
        if (verdict !== true) {
          const fLevel = config.friendLevel ?? 0;
          if (fLevel > 0 && session.onebot && session.userId) {
            const stats = await session.onebot.getStrangerInfo(session.userId, true).catch(() => ({})) as UserStats;
            const isLevelMatched = (stats.qqLevel ?? 0) >= fLevel;
            if (config.debugMode) logger.info(`[好友验证] 用户 ${session.userId} 等级 ${stats.qqLevel ?? 0}${isLevelMatched ? '>' : '<'}${fLevel}`);
            if (isLevelMatched) verdict = true;
          }
        }
      } else if (kind === 'guild') {
        if (ctx.database && session.userId) {
          const userData = await ctx.database.getUser(session.platform, session.userId, ['authority']).catch(() => null);
          if (userData && userData.authority > 3) {
            if (config.debugMode) logger.info(`[群组邀请] 用户 ${session.userId} 权限 ${userData.authority}>3`);
            verdict = true;
          }
        }
        if (verdict !== true && session.onebot && session.guildId) {
          const stats = await session.onebot.getGroupInfo(session.guildId, true).catch(() => ({})) as GroupStats;
          const minM = config.minMembers ?? 0;
          const maxC = config.maxCapacity ?? 0;
          if (minM > 0 && (stats.member_count ?? 0) < minM) {
            verdict = `群成员不足 ${minM} 人`;
            if (config.debugMode) logger.info(`[群组邀请] 群组 ${session.guildId} 成员数 ${stats.member_count ?? 0}<${minM}`);
          } else if (maxC > 0 && (stats.max_member_count ?? 0) < maxC) {
            verdict = `群容量不足 ${maxC} 人`;
            if (config.debugMode) logger.info(`[群组邀请] 群组 ${session.guildId} 受邀容量 ${stats.max_member_count ?? 0}<${maxC}`);
          } else {
            verdict = (minM > 0 || maxC > 0);
            if (config.debugMode && verdict) logger.info(`[群组邀请] 群组 ${session.guildId} 成员数 ${stats.member_count ?? 0}>${minM}，受邀容量 ${stats.max_member_count ?? 0}>${maxC}`);
          }
        }
      }
      if (verdict === true) {
        await executeAction(session, kind, true);
        await sendNotice(session, kind, 'auto_pass');
      } else if (typeof verdict === 'string') {
        await executeAction(session, kind, false, verdict);
        await sendNotice(session, kind, 'auto_reject');
      } else {
        await setupManual(session, kind);
      }
    } catch (error) {
      logger.error(`处理失败: ${error}`);
    }
  };

  const handleSpecialVote = async (session: Session, task: VerifyTask, isApprove: boolean, extraInfo: string, targetType: string, targetId: string) => {
    if (!task.voteTarget || !task.votes) return;
    const voterId = session.userId;
    if (!voterId) return;
    task.votes.yes.delete(voterId);
    task.votes.no.delete(voterId);
    if (isApprove) {
      task.votes.yes.add(voterId);
    } else {
      task.votes.no.add(voterId);
    }
    if (config.debugMode) logger.info(`[投票] 赞成: ${task.votes.yes.size}/${task.voteTarget.yes} | 反对: ${task.votes.no.size}/${task.voteTarget.no}`);
    let thresholdMet = false;
    let finalVerdict = false;
    if (task.voteTarget.yes > 0 && task.votes.yes.size >= task.voteTarget.yes) {
      thresholdMet = true;
      finalVerdict = true;
    } else if (task.voteTarget.no > 0 && task.votes.no.size >= task.voteTarget.no) {
      thresholdMet = true;
      finalVerdict = false;
    }
    if (!thresholdMet) return;
    task.messages.forEach(msg => activeTasks.delete(msg));
    const isSuccess = await executeAction(task.session, task.kind, finalVerdict, finalVerdict ? '' : extraInfo);
    const replyText = isSuccess ? `已${finalVerdict ? '通过' : '拒绝'}该投票` : `处理投票失败`;
    if (session.bot) await (targetType === 'private' ? session.bot.sendPrivateMessage(targetId, replyText) : session.bot.sendMessage(targetId, replyText)).catch(() => {});
  };

  ctx.on('friend-request', hookEvent('friend'));
  ctx.on('guild-request', hookEvent('guild'));
  ctx.on('guild-member-request', hookEvent('member'));
  ctx.on('guild-added', hookEvent('guild'));

  ctx.on('guild-removed', async (session) => {
    if (session.event?._data?.sub_type === 'kick_me') {
      const gid = session.guildId;
      if (gid) {
        const inviterId = inviterMap.get(gid);
        if (inviterId) {
          await session.onebot?.deleteFriend(inviterId).catch(() => {});
          inviterMap.delete(gid);
          if (config.debugMode) logger.info(`[操作] 删除好友: ${inviterId}`);
        }
        await session.execute(`analyse.clear -g ${gid}`).catch(() => {});
      }
    }
    await sendNotice(session, 'removed');
  });

  ctx.middleware(async (session, next) => {
    if (typeof session.content !== 'string' || !session.quote?.id) return next();
    const task = activeTasks.get(session.quote.id);
    if (!task) return next();
    const [targetType, targetId] = (config.notifyTarget || '').split(':');
    const isMatched = targetType === 'private' ? (session.userId === targetId) : (session.guildId === targetId);
    if (!isMatched) return next();
    const input = session.content.replace(/<(quote|at)\s+[^>]*\/>/gi, '').trim();
    const cmdMatch = input.match(/^(y|n|通过|拒绝)(?:\s+(.*))?$/i);
    if (!cmdMatch) return next();
    const isApprove = ['y', '通过'].includes(cmdMatch[1].toLowerCase());
    const extraInfo = cmdMatch[2]?.trim() || '';
    if (config.debugMode) logger.info(`[操作] 收到指令: ${isApprove ? '同意' : '拒绝'}`);
    if (task.specialMode === 'vote') {
      await handleSpecialVote(session, task, isApprove, extraInfo, targetType, targetId);
      return;
    }
    if (task.timer) clearTimeout(task.timer);
    task.messages.forEach(msg => activeTasks.delete(msg));
    const isSuccess = await executeAction(task.session, task.kind, isApprove, isApprove ? '' : extraInfo, (isApprove && task.kind === 'friend') ? extraInfo : '');
    const replyText = isSuccess ? `已${isApprove ? '通过' : '拒绝'}该请求` : `处理请求失败`;
    if (session.bot) await (targetType === 'private' ? session.bot.sendPrivateMessage(targetId, replyText) : session.bot.sendMessage(targetId, replyText)).catch(() => {});
  });
}
