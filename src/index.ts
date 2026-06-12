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

interface CaptchaTask {
  guildId: string;
  userId: string;
  answer: string;
  timer: NodeJS.Timeout;
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
  specialRules?: {
    guildId: string;
    enabled: boolean;
    mode: 'vote' | 'captcha';
  }[]
  captchaDiff?: 'simple' | 'medium' | 'hard'
  voteRatio?: string
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
    })).description('普通验证配置').role('table'),
  }).description('加群请求配置'),
  Schema.object({
    specialRules: Schema.array(Schema.object({
      guildId: Schema.string().description('群号').required(),
      mode: Schema.union([
        Schema.const('vote').description('投票'),
        Schema.const('captcha').description('验证码'),
      ]).description('模式').default('vote'),
      enabled: Schema.boolean().description('前置规则').default(true),
    })).description('配置列表').role('table'),
    voteRatio: Schema.string().description('[投票]人数').default('3:2'),
    captchaDiff: Schema.union([
      Schema.const('simple').description('简单'),
      Schema.const('medium').description('中等'),
      Schema.const('hard').description('困难'),
    ]).description('[验证码]难度').default('simple'),
  }).description('特殊验证配置')
])

export function apply(ctx: Context, config: Config = {}) {
  const logger = new Logger('onebot-verifier');
  const activeTasks = new Map<string, VerifyTask>();
  const activeCaptchas = new Map<string, CaptchaTask>();
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
      if (status === 'waiting' && kind !== 'removed') infoLines.push(`回复"y/n"以同意/拒绝该请求`);
      const content = infoLines.join('\n');
      const msgIds = await (targetType === 'private' ? session.bot.sendPrivateMessage(targetId, content) : session.bot.sendMessage(targetId, content)) || [];
      return msgIds;
    } catch (error) {
      logger.error(`通知失败: ${error}`);
      return [];
    }
  };

  const setupManual = async (session: Session, kind: RequestType, specialMode?: 'vote') => {
    const waitMinutes = config.timeout ?? 0;
    const action = kind === 'member' ? config.verifyMode : config.timeoutAction;
    const msgIds = await sendNotice(session, kind, 'waiting');
    if (!msgIds?.length) return;
    const task: VerifyTask = { session, kind, messages: msgIds, specialMode };
    if (specialMode === 'vote') {
      const [yesStr, noStr] = config.voteRatio!.split(':');
      task.voteTarget = { yes: parseInt(yesStr) || 0, no: parseInt(noStr) || 0 };
      task.votes = { yes: new Set(), no: new Set() };
    }
    msgIds.forEach(id => activeTasks.set(id, task));
    if (waitMinutes > 0 && (specialMode === 'vote' || action !== 'manual')) {
      task.timer = setTimeout(async () => {
        if (!activeTasks.has(msgIds[0])) return;
        msgIds.forEach(id => activeTasks.delete(id));
        let finalAction = action;
        if (specialMode === 'vote' && finalAction === 'manual') finalAction = 'reject';
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
    }
  };

  const hookEvent = (kind: RequestType) => async (session: Session) => {
    const eventData = session.event?._data || {};
    if (eventData.user_id) session.userId = String(eventData.user_id);
    if (eventData.group_id) session.guildId = String(eventData.group_id);
    try {
      if (config.debugMode) logger.info(`[请求] 类型: ${kind} 数据: ${JSON.stringify(eventData)}`);
      const verifyText = getComment(eventData.comment);
      if (kind === 'member') {
        const rules = config.verifyRules?.filter(r => String(r.guildId) === String(session.guildId)) || [];
        for (const rule of rules) {
          const stats = ((rule.minLevel ?? 0) > 0 && session.onebot && session.userId) ? await session.onebot.getStrangerInfo(session.userId, true).catch(() => ({})) as UserStats : null;
          const levelMatch = (stats?.qqLevel ?? 0) >= (rule.minLevel ?? 0);
          const keywordMatch = !rule.keyword || new RegExp(rule.keyword, 'i').test(verifyText);
          if (config.debugMode) {
            if ((rule.minLevel ?? 0) > 0) logger.info(`[加群请求] ${session.userId} 等级 ${stats?.qqLevel ?? 0} ${levelMatch ? '>' : '<'} "${rule.minLevel ?? 0}"`);
            if (rule.keyword) logger.info(`[加群请求] ${session.userId} 内容 "${verifyText}" ${keywordMatch ? '=' : '≠'} "${rule.keyword}"`);
          }
          if (levelMatch && keywordMatch) {
            if (rule.action) {
              await executeAction(session, kind, rule.action === 'accept', rule.action === 'accept' ? '' : '命中规则，自动拒绝');
              await sendNotice(session, kind, rule.action === 'accept' ? 'auto_pass' : 'auto_reject');
              return;
            }
          }
        }
        const specialRule = config.specialRules?.find(r => String(r.guildId) === String(session.guildId) && r.enabled);
        if (specialRule) {
          if (specialRule.mode === 'vote') return await setupManual(session, kind, 'vote');
          if (specialRule.mode === 'captcha') {
            await executeAction(session, kind, true, '验证码验证，自动通过');
            await sendNotice(session, kind, 'auto_pass');
            return;
          }
        }
        return await setupManual(session, kind);
      }
      let verdict: boolean | string = false;
      if (kind === 'friend') {
        let levelPass = true, regexPass = true;
        if (config.friendLevel && config.friendLevel > 0 && session.onebot && session.userId) {
          const stats = await session.onebot.getStrangerInfo(session.userId, true).catch(() => ({})) as UserStats;
          levelPass = (stats.qqLevel ?? 0) >= config.friendLevel;
          if (config.debugMode) logger.info(`[好友验证] ${session.userId} 等级 ${stats.qqLevel ?? 0} ${levelPass ? '>' : '<'} "${config.friendLevel}"`);
        }
        if (config.friendRegex) {
          regexPass = new RegExp(config.friendRegex, 'i').test(verifyText);
          if (config.debugMode) logger.info(`[好友验证] ${session.userId} 内容 "${verifyText}" ${regexPass ? '=' : '≠'} "${config.friendRegex}"`);
        }
        verdict = levelPass && regexPass;
      }
      else if (kind === 'guild') {
        if (ctx.database && session.userId) {
          const auth = (await ctx.database.getUser(session.platform, session.userId, ['authority']).catch(() => null))?.authority ?? 0;
          if (auth > 3) {
            if (config.debugMode) logger.info(`[群组邀请] ${session.userId} 权限 ${auth} > 3`);
            verdict = true;
          }
        }
        if (verdict !== true && session.onebot && session.guildId) {
          const stats = await session.onebot.getGroupInfo(session.guildId, true).catch(() => ({})) as GroupStats;
          const minPass = (stats.member_count ?? 0) >= (config.minMembers ?? 0);
          const maxPass = (stats.max_member_count ?? 0) >= (config.maxCapacity ?? 0);
          if (config.debugMode) {
            if ((config.minMembers ?? 0) > 0) logger.info(`[群组邀请] ${session.guildId} 人数 ${stats.member_count ?? 0} ${minPass ? '>' : '<'} "${config.minMembers ?? 0}"`);
            if ((config.maxCapacity ?? 0) > 0) logger.info(`[群组邀请] ${session.guildId} 容量 ${stats.max_member_count ?? 0} ${maxPass ? '>' : '<'} "${config.maxCapacity ?? 0}"`);
          }
          if (!minPass) verdict = `群人数不足 ${config.minMembers ?? 0} 人`;
          else if (!maxPass) verdict = `群容量不足 ${config.maxCapacity ?? 0} 人`;
          else verdict = ((config.minMembers ?? 0) > 0 || (config.maxCapacity ?? 0) > 0);
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
    if (task.timer) clearTimeout(task.timer);
    task.messages.forEach(msg => activeTasks.delete(msg));
    const isSuccess = await executeAction(task.session, task.kind, finalVerdict, finalVerdict ? '' : extraInfo);
    const replyText = isSuccess ? `已${finalVerdict ? '通过' : '拒绝'}该投票` : `处理投票失败`;
    if (session.bot) await (targetType === 'private' ? session.bot.sendPrivateMessage(targetId, replyText) : session.bot.sendMessage(targetId, replyText)).catch(() => {});
  };

  ctx.on('friend-request', hookEvent('friend'));
  ctx.on('guild-request', hookEvent('guild'));
  ctx.on('guild-member-request', hookEvent('member'));
  ctx.on('guild-added', hookEvent('guild'));

  ctx.on('guild-member-added', async (session) => {
    if (!config.specialRules || !session.guildId || !session.userId) return;
    const rule = config.specialRules.find(r => String(r.guildId) === String(session.guildId) && r.enabled);
    if (rule?.mode === 'captcha') {
      let a: number, b: number, op: string = '+', answer: string;
      if (config.captchaDiff === 'simple') {
        a = Math.floor(Math.random() * 80) + 10;
        b = Math.floor(Math.random() * 80) + 10;
        if (Math.random() > 0.5) {
          op = '+';
          answer = (a + b).toString();
        } else {
          op = '-';
          if (a < b) [a, b] = [b, a];
          answer = (a - b).toString();
        }
      } else if (config.captchaDiff === 'medium') {
        a = Math.floor(Math.random() * 89) + 11;
        b = Math.floor(Math.random() * 8) + 2;
        op = '×';
        answer = (a * b).toString();
      } else {
        a = Math.floor(Math.random() * 40) + 11;
        b = Math.floor(Math.random() * 10) + 11;
        op = '×';
        answer = (a * b).toString();
      }
      const captchaKey = `${session.guildId}:${session.userId}`;
      await session.send(`<at id="${session.userId}"/> 请在 60 秒内回复计算结果，以进行验证：${a} ${op} ${b} =`);
      const timer = setTimeout(async () => {
        if (activeCaptchas.has(captchaKey)) {
          activeCaptchas.delete(captchaKey);
          await session.send(`<at id="${session.userId}"/> 验证失败，将被移出本群。`);
          await session.onebot?.setGroupKick(session.guildId!, session.userId!, false);
        }
      }, 60000);
      activeCaptchas.set(captchaKey, { guildId: session.guildId, userId: session.userId, answer, timer });
    }
  });

  ctx.on('guild-removed', async (session) => {
    if (session.guildId) {
      if (session.event?._data?.sub_type === 'kick_me') {
        const inviterId = inviterMap.get(session.guildId);
        if (inviterId) {
          await session.onebot?.deleteFriend(inviterId).catch(() => {});
          inviterMap.delete(session.guildId);
          if (config.debugMode) logger.info(`[操作] 删除好友: ${inviterId}`);
        }
      }
      await session.execute(`analyse.clear -g ${session.guildId}`).catch(() => {});
      if (config.debugMode) logger.info(`[操作] 清理群组数据: ${session.guildId}`);
    }
    await sendNotice(session, 'removed');
  });

  ctx.middleware(async (session, next) => {
    if (typeof session.content !== 'string') return next();
    if (session.guildId && session.userId) {
      const captchaKey = `${session.guildId}:${session.userId}`;
      const captcha = activeCaptchas.get(captchaKey);
      if (captcha) {
        const input = session.content.trim();
        if (input === captcha.answer) {
          clearTimeout(captcha.timer);
          activeCaptchas.delete(captchaKey);
          await session.send(`<at id="${session.userId}"/> 验证成功，欢迎加入本群！`);
          return;
        }
      }
    }
    if (!session.quote?.id) return next();
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
