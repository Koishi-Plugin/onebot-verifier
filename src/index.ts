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
type NoticeStatus = 'auto_pass' | 'auto_reject' | 'waiting'
type VoteTarget = { yes: number, no: number }

interface UserStats {
  user_id?: number
  qqLevel?: number
  qq_level?: number
  level?: number | string
}

interface GroupStats {
  group_id?: number
  group_name?: string
  member_count?: number
  max_member_count?: number
}

interface VerifyTask {
  session: Session;
  kind: RequestType;
  messages: string[];
  target: string;
  timer?: NodeJS.Timeout;
  specialMode?: 'vote';
  voteTarget?: VoteTarget;
  votes?: { yes: Set<string>, no: Set<string> };
  inSitu?: boolean;
}

interface CaptchaTask {
  answer: string;
  timer: NodeJS.Timeout;
}

export interface Config {
  notifyTarget?: string
  debugMode?: boolean
  kickBan?: boolean
  blacklist?: string[]
  friendTimeout: false | number
  friendLevel?: number
  friendRegex?: string
  minMembers?: number
  maxCapacity?: number
  memberTimeout: false | number
  frequencyMode: 'delay' | 'ignore' | 'reject'
  verifyRules?: {
    guildId: string;
    keyword?: string;
    minLevel?: number;
    frequency?: number;
    action?: 'accept' | 'reject'
  }[]
  specialRules?: {
    guildId: string;
    mode: 'vote' | 'captcha';
  }[]
  captchaDiff?: 'simple' | 'medium' | 'hard'
  voteRatio?: string
  voteInSitu?: boolean
}

export const Config: Schema<Config> = Schema.intersect([
  Schema.object({
    notifyTarget: Schema.string().description('通知目标(guild/private:number)').required(),
    debugMode: Schema.boolean().description('输出调试日志').default(false),
    kickBan: Schema.boolean().description('被踢自动处理').default(false),
    blacklist: Schema.array(Schema.string()).description('群组黑名单').role('table'),
  }).description('基础配置'),
  Schema.object({
    friendTimeout: Schema.union([
      Schema.const(false).description('手动'),
      Schema.number().description('自动').default(360),
    ]).description('超时处理').default(false),
    friendLevel: Schema.number().description('最低好友等级').default(0).min(0).max(256),
    friendRegex: Schema.string().description('好友验证正则'),
    minMembers: Schema.number().description('最低群成员数').default(0).min(0).max(3000),
    maxCapacity: Schema.number().description('最低受邀容量').default(0).min(0).max(3000),
  }).description('好友邀群配置'),
  Schema.object({
    memberTimeout: Schema.union([
      Schema.const(false).description('手动'),
      Schema.number().description('自动').default(360),
    ]).description('超时处理').default(false),
    frequencyMode: Schema.union([
      Schema.const('delay').description('延时'),
      Schema.const('ignore').description('忽略'),
      Schema.const('reject').description('拒绝'),
    ]).description('频率限制').default('delay'),
    verifyRules: Schema.array(Schema.object({
      guildId: Schema.string().description('群号').required(),
      keyword: Schema.string().description('正则'),
      minLevel: Schema.number().description('等级').default(0),
      frequency: Schema.number().description('频率').default(0),
      action: Schema.union([
        Schema.const('accept').description('同意'),
        Schema.const('reject').description('拒绝'),
      ]).description('操作'),
    })).description('普通验证').role('table'),
    specialRules: Schema.array(Schema.object({
      guildId: Schema.string().description('群号').required(),
      mode: Schema.union([
        Schema.const('vote').description('投票'),
        Schema.const('captcha').description('验证码'),
      ]).description('模式').default('vote'),
    })).description('高级验证').role('table'),
  }).description('加群请求配置'),
  Schema.object({
    voteInSitu: Schema.boolean().description('[投票]原群投票模式').default(true),
    voteRatio: Schema.string().description('[投票]支持/反对人数').default('5:2'),
    captchaDiff: Schema.union([
      Schema.const('simple').description('简单'),
      Schema.const('medium').description('中等'),
      Schema.const('hard').description('困难'),
    ]).description('[验证]计算难度').default('simple'),
  }).description('模式配置')
])

const REQUEST_LABEL = { friend: '好友申请', member: '加群请求' } as const
const STATUS_LABEL = { auto_pass: ' [自动通过]', auto_reject: ' [自动拒绝]', waiting: ' [等待处理]' } as const
const CAPTCHA_TIMEOUT = 60000

const randInt = (min: number, max: number) => min + Math.floor(Math.random() * (max - min + 1))

export function apply(ctx: Context, config: Config) {
  const logger = new Logger('onebot-verifier')
  const activeTasks = new Map<string, VerifyTask>()
  const activeCaptchas = new Map<string, CaptchaTask>()
  const inviterMap = new Map<string, string>()
  const historyMap = new Map<string, number>()

  const debug = (message: string) => {
    if (config.debugMode) logger.info(message)
  }

  const toObject = <T extends object>(value: unknown): T => (value && typeof value === 'object' ? value as T : {} as T)

  const getEventData = (session: Session): Record<string, any> => session.event?._data || {}

  const getGuildKey = (session: Session) => `${session.userId}:${session.guildId}`

  const getQQLevel = (stats?: UserStats | null) => +(stats?.qqLevel ?? stats?.qq_level ?? stats?.level ?? 0)

  const getVoteTarget = (): VoteTarget => {
    const [yes, no] = (config.voteRatio || '').split(':')
    return { yes: parseInt(yes) || 0, no: parseInt(no) || 0 }
  }

  const getComment = (comment?: string) => {
    if (!comment) return '';
    const answers = comment.split(/[\r\n]+/)
      .map(line => line.trim())
      .filter(line => /^(回答|答案)[:：]/.test(line))
      .map(line => line.replace(/^(回答|答案)[:：]\s*/, ''))
    return answers.length ? answers.join('\n') : comment
  }

  const safeRegExp = (pattern?: string) => {
    if (!pattern) return null;
    try {
      return new RegExp(pattern, 'i');
    } catch {
      return null;
    }
  }

  const getStrangerLevel = async (session: Session) => {
    if (!session.onebot || !session.userId) return 0;
    const stats = toObject<UserStats>(await session.onebot.getStrangerInfo(session.userId, true).catch(() => null));
    return getQQLevel(stats);
  };

  const pushText = async (session: Session, target: string | undefined, content: string) => {
    const [type, id] = (target || '').split(':');
    if (!id || !session.bot) return;
    await (type === 'private' ? session.bot.sendPrivateMessage(id, content) : session.bot.sendMessage(id, content)).catch(() => {});
  };

  const addTask = (task: VerifyTask) => task.messages.forEach(id => activeTasks.set(id, task));

  const removeTask = (task: VerifyTask) => {
    if (task.timer) clearTimeout(task.timer);
    task.messages.forEach(id => activeTasks.delete(id));
  };

  const isActive = (task: VerifyTask) => task.messages.some(id => activeTasks.has(id));

  const startTimer = (task: VerifyTask, timeout: false | number, forcePass?: boolean) => {
    if (typeof timeout !== 'number') return;
    if (task.timer) clearTimeout(task.timer);
    const pass = task.specialMode === 'vote' ? false : forcePass ?? timeout > 0;
    task.timer = setTimeout(async () => {
      if (!isActive(task)) return;
      removeTask(task);
      await executeAction(task.session, task.kind, pass, pass ? '' : '等待超时，自动拒绝');
      await pushText(task.session, task.target, `已自动${pass ? '通过' : '拒绝'}该请求`);
      debug(`[操作] 等待超时，默认${pass ? '通过' : '拒绝'}`);
    }, Math.abs(timeout) * 60000);
  };

  const setFriendRemark = async (session: Session, userId: string, remark: string) => {
    const onebot = session.onebot as any;
    try {
      if (onebot.setFriendRemark) await onebot.setFriendRemark(userId, remark);
      else await onebot._get('set_friend_remark', { user_id: userId, remark });
    } catch (error) {
      logger.warn(`设置好友备注失败: ${error}`);
    }
  };

  const leaveGuild = async (session: Session, reason: string) => {
    if (reason) await pushText(session, `guild:${session.guildId}`, `${reason}，将退出该群`);
    const left = await session.onebot?.setGroupLeave(session.guildId!, false).then(() => true, () => false);
    debug(`[操作] ${left ? '退出群组' : '退出群组失败'}: ${session.guildId}`);
    return !!left;
  };

  const executeAction = async (session: Session, kind: RequestType, pass: boolean, reason = '', remark = ''): Promise<boolean> => {
    const eventData = getEventData(session);
    try {
      debug(`[操作] 类型: ${kind} 结果: ${pass ? '同意' : '拒绝'} 原因: ${reason || '无'}`);
      if (kind === 'guild') {
        if (pass && session.guildId && session.userId && session.userId !== session.selfId) inviterMap.set(session.guildId, session.userId);
        if (!pass && session.guildId) {
          const targetId = String(eventData.operator_id || session.userId || '');
          if (targetId && targetId !== session.selfId) await pushText(session, `private:${targetId}`, `已拒绝该群组邀请${reason ? `，原因：${reason}` : ''}`);
          if (eventData.notice_type === 'group_increase') return await leaveGuild(session, reason);
        }
      }
      const flag = eventData.flag;
      if (!flag || !session.onebot) return false;
      if (kind === 'friend') {
        await session.onebot.setFriendAddRequest(flag, pass, remark);
        if (pass && remark) setTimeout(() => void setFriendRemark(session, session.userId!, remark), 1000);
      } else {
        await session.onebot.setGroupAddRequest(flag, eventData.sub_type ?? 'add', pass, pass ? '' : reason);
      }
      return true;
    } catch (error) {
      logger.error(`操作失败(${kind}${session.guildId ? ` 群 ${session.guildId}` : ''}${session.userId ? ` 用户 ${session.userId}` : ''}): ${error}`);
      return false;
    }
  };

  const sendNotice = async (session: Session, kind: RequestType, status: NoticeStatus = 'waiting', target?: string, specialMode?: 'vote'): Promise<string[]> => {
    const [targetType, targetId] = (target || config.notifyTarget || '').split(':');
    if (!targetId || !session.bot) return [];
    try {
      const eventData = getEventData(session);
      const userInfo = session.userId ? await session.bot.getUser?.(session.userId).catch(() => null) : null;
      const groupInfo = (kind !== 'friend' && session.guildId) ? await session.bot.getGuild?.(session.guildId).catch(() => null) : null;
      const adminId = String(eventData.operator_id || '');
      const adminInfo = (adminId && adminId !== session.userId) ? await session.bot.getUser?.(adminId).catch(() => null) : null;
      const label = kind === 'guild'
        ? (eventData.post_type === 'notice' ? '群组邀请 (审核)' : '群组邀请 (请求)')
        : kind === 'removed'
          ? (eventData.sub_type === 'kick_me' ? '移出群组' : '退出群组')
          : REQUEST_LABEL[kind];
      const infoLines: string[] = [];
      if (userInfo?.avatar) infoLines.push(`<image url="${userInfo.avatar}"/>`);
      infoLines.push(`类型：${label}${kind === 'removed' ? (eventData.sub_type === 'kick_me' && config.kickBan ? ' [自动清理]' : '') : STATUS_LABEL[status]}`);
      if ((kind !== 'guild' && kind !== 'removed') || (session.userId && session.userId !== session.selfId)) infoLines.push(`用户：${userInfo?.name || session.userId}${session.userId ? `(${session.userId})` : ''}`);
      if (adminId) infoLines.push(`管理：${adminInfo?.name ? `${adminInfo.name}(${adminId})` : adminId}`);
      if (session.guildId) infoLines.push(`群组：${groupInfo?.name ? `${groupInfo.name}(${session.guildId})` : session.guildId}`);
      if (eventData.inviter_id && String(eventData.inviter_id) !== '0') infoLines.push(`邀请者：${eventData.inviter_id}`);
      if (eventData.comment) infoLines.push(`验证信息：${eventData.comment}`);
      if (eventData.via) infoLines.push(`来源：${eventData.via}`);
      if (status === 'waiting' && kind !== 'removed') {
        if (specialMode === 'vote') {
          const { yes, no } = getVoteTarget();
          infoLines.push(`[投票模式]需${yes}人同意或${no}人拒绝`);
        }
        infoLines.push(`使用"y/n"回复本消息以处理该请求`);
      }
      const content = infoLines.join('\n');
      return await (targetType === 'private' ? session.bot.sendPrivateMessage(targetId, content) : session.bot.sendMessage(targetId, content)) || [];
    } catch (error) {
      logger.error(`通知失败: ${error}`);
      return [];
    }
  };

  const decide = async (session: Session, kind: RequestType, pass: boolean, reason = '') => {
    await executeAction(session, kind, pass, reason);
    await sendNotice(session, kind, pass ? 'auto_pass' : 'auto_reject');
  };

  const setupManual = async (session: Session, kind: RequestType, specialMode?: 'vote', useInSitu?: boolean, forcePass?: boolean) => {
    const timeout = kind === 'member' ? config.memberTimeout : config.friendTimeout;
    const target = (useInSitu && kind === 'member' && session.guildId) ? `guild:${session.guildId}` : config.notifyTarget || '';
    const messages = await sendNotice(session, kind, 'waiting', target, specialMode);
    if (!messages?.length) return;
    const task: VerifyTask = { session, kind, messages, target, specialMode, inSitu: useInSitu };
    if (specialMode === 'vote') {
      task.voteTarget = getVoteTarget();
      task.votes = { yes: new Set(), no: new Set() };
    }
    addTask(task);
    startTimer(task, timeout, forcePass);
  };

  const getGroupStats = async (session: Session) => {
    let stats = toObject<GroupStats>(await session.onebot!.getGroupInfo(session.guildId!, true).catch(() => null));
    if (!stats.member_count) {
      stats = toObject<GroupStats>(await (session.onebot as any)._get('get_group_detail_info', { group_id: +session.guildId!, no_cache: true }).catch((error: unknown) => {
        debug(`[群组邀请] 获取信息失败: ${String(error)}`);
        return null;
      }));
    }
    return { memberCount: +(stats.member_count ?? 0), capacity: +(stats.max_member_count ?? 0) };
  };

  const checkFriend = async (session: Session, verifyText: string) => {
    let pass = true;
    const minLevel = config.friendLevel ?? 0;
    if (minLevel > 0 && session.onebot && session.userId) {
      const level = await getStrangerLevel(session);
      pass = level >= minLevel;
      debug(`[好友验证] ${session.userId} 等级 ${level} ${pass ? '>' : '<'} ${minLevel}`);
    }
    const regex = safeRegExp(config.friendRegex);
    if (regex) {
      const matched = regex.test(verifyText);
      debug(`[好友验证] ${session.userId} 内容 "${verifyText}" ${matched ? '=' : '≠'} "${config.friendRegex}"`);
      pass = pass && matched;
    }
    return pass;
  };

  const checkGuild = async (session: Session): Promise<boolean | string> => {
    if (ctx.database && session.userId) {
      const auth = (await ctx.database.getUser(session.platform, session.userId, ['authority']).catch(() => null))?.authority ?? 0;
      if (auth > 3) {
        debug(`[群组邀请] ${session.userId} 权限 ${auth} > 3`);
        return true;
      }
    }
    const minMembers = config.minMembers ?? 0;
    const maxCapacity = config.maxCapacity ?? 0;
    if (!session.onebot || !session.guildId || (minMembers <= 0 && maxCapacity <= 0)) return false;
    const { memberCount, capacity } = await getGroupStats(session);
    const memberKnown = memberCount > 0;
    const capacityKnown = maxCapacity <= 0 || capacity > 0;
    if (minMembers > 0) debug(`[群组邀请] ${session.guildId} 人数 ${memberKnown ? `${memberCount} ${memberCount >= minMembers ? '>' : '<'}` : '未知'} ${minMembers}`);
    if (maxCapacity > 0) debug(`[群组邀请] ${session.guildId} 容量 ${capacityKnown ? `${capacity} ${capacity >= maxCapacity ? '>' : '<'}` : '未知'} ${maxCapacity}`);
    if (!memberKnown || !capacityKnown) return false;
    if (memberCount < minMembers) return `群人数不足 ${minMembers} 人`;
    if (capacity < maxCapacity) return `群容量不足 ${maxCapacity} 人`;
    return true;
  };

  const handleMemberRequest = async (session: Session, verifyText: string) => {
    const rules = config.verifyRules?.filter(rule => rule.guildId === session.guildId) || [];
    for (const rule of rules) {
      const keyword = safeRegExp(rule.keyword);
      if (rule.keyword && !keyword) continue;
      const minLevel = rule.minLevel ?? 0;
      const level = minLevel > 0 ? await getStrangerLevel(session) : 0;
      const levelMatch = level >= minLevel;
      const keywordMatch = !keyword || keyword.test(verifyText);
      debug(`[加群请求] ${session.userId} ${minLevel > 0 ? `等级 ${level} ${levelMatch ? '>' : '<'} ${minLevel} ` : ''}${rule.keyword ? `内容 "${verifyText}" ${keywordMatch ? '=' : '≠'} "${rule.keyword}"` : ''}`.trim());
      if (!levelMatch || !keywordMatch) continue;
      const frequency = rule.frequency ?? 0;
      const lastLeave = historyMap.get(getGuildKey(session)) || 0;
      if (frequency > 0 && Date.now() - lastLeave < frequency * 60000) {
        if (config.frequencyMode === 'reject') return await decide(session, 'member', false, '频繁申请，自动拒绝');
        if (config.frequencyMode === 'ignore' || config.frequencyMode === 'delay') {
          return await setupManual(session, 'member', undefined, false, config.frequencyMode === 'delay' && rule.action === 'accept');
        }
      }
      if (rule.action) return await decide(session, 'member', rule.action === 'accept', rule.action === 'accept' ? '' : '错误回答，自动拒绝');
    }
    const specialRule = config.specialRules?.find(rule => rule.guildId === session.guildId);
    if (specialRule?.mode === 'vote') return await setupManual(session, 'member', 'vote', config.voteInSitu);
    if (specialRule?.mode === 'captcha') return await decide(session, 'member', true, '验证码验证，自动通过');
    return await setupManual(session, 'member');
  };

  const handleVote = async (session: Session, task: VerifyTask, approve: boolean, reason: string) => {
    const { votes, voteTarget } = task;
    if (!votes || !voteTarget || !session.userId) return;
    votes.yes.delete(session.userId);
    votes.no.delete(session.userId);
    approve ? votes.yes.add(session.userId) : votes.no.add(session.userId);
    debug(`[投票] 赞成: ${votes.yes.size}/${voteTarget.yes} | 反对: ${votes.no.size}/${voteTarget.no}`);
    const met = voteTarget.yes > 0 && votes.yes.size >= voteTarget.yes
      ? true
      : voteTarget.no > 0 && votes.no.size >= voteTarget.no ? false : null;
    if (met === null) return;
    removeTask(task);
    const success = await executeAction(task.session, task.kind, met, met ? '' : reason);
    if (!task.inSitu) await session.send(success ? `已${met ? '通过' : '拒绝'}该投票` : `处理投票失败`).catch(() => {});
  };

  const refreshFriendTask = (session: Session, verifyText: string) => {
    const task = [...activeTasks.values()].find(item => item.kind === 'friend' && item.session.userId === session.userId);
    if (!task) return false;
    if (getComment(getEventData(task.session).comment) === verifyText) {
      task.session = session;
      startTimer(task, config.friendTimeout);
      return true;
    }
    removeTask(task);
    return false;
  };

  const hookEvent = (kind: RequestType) => async (session: Session) => {
    const eventData = getEventData(session);
    if (eventData.user_id) session.userId = String(eventData.user_id);
    if (eventData.group_id) session.guildId = String(eventData.group_id);
    const isApply = kind === 'guild' && eventData.post_type === 'request' && !!eventData.invited_id && String(eventData.invited_id) !== String(eventData.self_id);
    if (isApply) session.userId = String(eventData.invited_id);
    if (session.guildId && config.blacklist?.includes(session.guildId)) return;
    const realKind: RequestType = isApply ? 'member' : kind;
    try {
      debug(`[请求] 类型: ${realKind} 数据: ${JSON.stringify(eventData)}`);
      const verifyText = getComment(eventData.comment);
      if (kind === 'friend' && refreshFriendTask(session, verifyText)) return;
      if (realKind === 'member') return await handleMemberRequest(session, verifyText);
      const verdict = kind === 'friend' ? await checkFriend(session, verifyText) : await checkGuild(session);
      if (verdict === true) return await decide(session, kind, true);
      if (typeof verdict === 'string') return await decide(session, kind, false, verdict);
      await setupManual(session, kind);
    } catch (error) {
      logger.error(`[请求] 处理失败(${realKind}): ${error}`);
    }
  };

  const createCaptcha = (diff?: Config['captchaDiff']) => {
    if (diff === 'medium' || diff === 'hard') {
      const hard = diff === 'hard';
      const a = hard ? randInt(11, 50) : randInt(11, 99);
      const b = hard ? randInt(11, 20) : randInt(2, 9);
      return { a, op: '×', b, answer: a * b };
    }
    const a = randInt(10, 89);
    const b = randInt(10, 89);
    return Math.random() > 0.5
      ? { a, op: '+', b, answer: a + b }
      : { a, op: '-', b: Math.min(a, b), answer: Math.abs(a - b) };
  };

  ctx.on('friend-request', hookEvent('friend'));
  ctx.on('guild-request', hookEvent('guild'));
  ctx.on('guild-member-request', hookEvent('member'));
  ctx.on('guild-added', hookEvent('guild'));

  ctx.on('guild-member-removed', async (session) => {
    const { guildId, userId } = session;
    if (!guildId || !userId || config.blacklist?.includes(guildId)) return;
    if (!config.verifyRules?.some(rule => rule.guildId === guildId)) return;
    const now = Date.now();
    historyMap.set(getGuildKey(session), now);
    const ttl = Math.max(0, ...config.verifyRules.map(rule => rule.frequency || 0)) * 60000;
    if (ttl > 0) for (const [key, time] of historyMap) if (now - time > ttl) historyMap.delete(key);
  });

  ctx.on('guild-member-added', async (session) => {
    const { guildId, userId } = session;
    if (!guildId || !userId || userId === session.selfId || config.blacklist?.includes(guildId)) return;
    if (config.specialRules?.find(rule => rule.guildId === guildId)?.mode !== 'captcha') return;
    const key = getGuildKey(session);
    const { a, op, b, answer } = createCaptcha(config.captchaDiff);
    await session.send(`<at id="${userId}"/> 请在 60 秒内回复计算结果，以进行验证：${a} ${op} ${b} =`).catch(() => {});
    const timer = setTimeout(async () => {
      if (!activeCaptchas.has(key)) return;
      activeCaptchas.delete(key);
      await session.send(`<at id="${userId}"/> 验证失败，将被移出本群。`).catch(() => {});
      await session.onebot?.setGroupKick(guildId, userId, false).catch(() => {});
    }, CAPTCHA_TIMEOUT);
    const previous = activeCaptchas.get(key);
    if (previous) clearTimeout(previous.timer);
    activeCaptchas.set(key, { answer: `${answer}`, timer });
  });

  ctx.on('guild-removed', async (session) => {
    const { guildId } = session;
    if (!guildId || config.blacklist?.includes(guildId)) return;
    const eventData = getEventData(session);
    debug(`[事件] 退出: ${guildId} 数据: ${JSON.stringify(eventData)}`);
    if (eventData.sub_type === 'kick_me') {
      const targets = new Set([inviterMap.get(guildId) || '', String(eventData.operator_id || '')]);
      for (const userId of targets) {
        if (!userId) continue;
        await session.onebot?.deleteFriend(userId).catch(() => {});
        debug(`[操作] 删除好友: ${userId}`);
      }
    }
    inviterMap.delete(guildId);
    await session.execute(`analyse.clear -g ${guildId}`).catch(() => {});
    debug(`[操作] 清理群组数据: ${guildId}`);
    await sendNotice(session, 'removed');
  });

  ctx.middleware(async (session, next) => {
    if (typeof session.content !== 'string') return next();
    if (session.guildId && session.userId) {
      const key = getGuildKey(session);
      const captcha = activeCaptchas.get(key);
      if (captcha && session.content.trim() === captcha.answer) {
        clearTimeout(captcha.timer);
        activeCaptchas.delete(key);
        await session.send(`<at id="${session.userId}"/> 验证成功，欢迎加入本群！`);
        return;
      }
    }
    const task = session.quote?.id ? activeTasks.get(session.quote.id) : undefined;
    if (!task) return next();
    const [type, id] = task.target.split(':');
    const inSitu = task.inSitu && session.guildId === task.session.guildId;
    if (!inSitu && (type === 'private' ? session.userId !== id : session.guildId !== id)) return next();
    const match = session.content.replace(/<(quote|at)\s+[^>]*\/>/gi, '').trim().match(/^(y|n|通过|拒绝)(?:\s+(.*))?$/i);
    if (!match) return next();
    const approve = ['y', '通过'].includes(match[1].toLowerCase());
    const reason = match[2]?.trim() || '';
    debug(`[操作] 收到指令: ${approve ? '同意' : '拒绝'}`);
    if (task.specialMode === 'vote') return await handleVote(session, task, approve, reason);
    removeTask(task);
    const success = await executeAction(task.session, task.kind, approve, approve ? '' : reason, task.kind === 'friend' ? reason : '');
    await session.send(success ? `已${approve ? '通过' : '拒绝'}该请求` : `处理请求失败`).catch(() => {});
  });
}
