import { Context, Schema, Logger, Session } from 'koishi'
import {} from "koishi-plugin-adapter-onebot";

export const name = 'onebot-verifier'
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

interface OneBotUserInfo {
  user_id: number
  qqLevel?: number
}

interface OneBotGroupInfo {
  group_id: number
  group_name: string
  member_count: number
  max_member_count: number
}

interface ActiveRequest {
  session: Session;
  type: RequestType;
  requestNumber: number;
  disposer?: () => void;
  timeoutTimer?: NodeJS.Timeout;
}

export interface Config {
  enable?: boolean
  notifyTarget?: string
  enableDebug?: boolean
  FriendLevel?: number
  FriendRequestAutoRegex?: string
  MemberRequestAutoRules?: { guildId: string; keyword: string; minLevel: number }[]
  GuildAllowUsers?: string[]
  GuildMinMemberCount?: number
  GuildMaxCapacity?: number
  manualTimeout?: number
  manualTimeoutAction?: 'accept' | 'reject'
}

export const Config: Schema<Config> = Schema.object({
  enable: Schema.boolean().description('开启请求监听').default(true),
  notifyTarget: Schema.string().description('通知目标(guild/private:number)').required(),
  enableDebug: Schema.boolean().description('开启调试日志').default(false),
  manualTimeout: Schema.number().description('请求超时时长').default(360).min(0),
  manualTimeoutAction: Schema.union([
    Schema.const('accept').description('同意'),
    Schema.const('reject').description('拒绝'),
  ]).description('默认超时操作').default('accept'),
  FriendLevel: Schema.number().description('最低好友等级').default(-1).min(-1).max(256),
  GuildMinMemberCount: Schema.number().description('最低群成员数').default(-1).min(-1).max(3000),
  GuildMaxCapacity: Schema.number().description('最低受邀容量').default(-1).min(-1).max(3000),
  FriendRequestAutoRegex: Schema.string().description('好友验证正则'),
  MemberRequestAutoRules: Schema.array(Schema.object({
    guildId: Schema.string().description('群号'),
    keyword: Schema.string().description('正则'),
    minLevel: Schema.number().description('等级').default(-1),
  })).description('加群验证规则').role('table'),
  GuildAllowUsers: Schema.array(String).description('邀请加群白名单').role('table'),
}).description('请求处理配置')

/**
 * 提取用户回答
 */
function extractAnswers(message: string): string {
  if (!message) return '';
  const lines = message.split(/[\r\n]+/);
  const answers = lines
    .map(line => line.trim())
    .filter(line => /^(回答)[:：]/i.test(line))
    .map(line => line.replace(/^(回答)[:：]\s*/i, ''));
  if (answers.length > 0) return answers.join('\n');
  return message;
}

export function apply(ctx: Context, config: Config = {}) {
  const logger = new Logger('onebot-verifier');

  // 状态管理
  const requestNumberMap = new Map<number, string>();
  let nextRequestNumber = 1;
  const activeRequests = new Map<string, ActiveRequest>();
  const processedFlags = new Set<string>();

  /**
   * 清理活动请求
   */
  const cleanupActiveRequest = (requestKey: string) => {
    const activeRequest = activeRequests.get(requestKey);
    if (!activeRequest) return;
    activeRequest.disposer?.();
    if (activeRequest.timeoutTimer) clearTimeout(activeRequest.timeoutTimer);
    requestNumberMap.delete(activeRequest.requestNumber);
    activeRequests.delete(requestKey);
  };

  /**
   * 执行请求操作
   */
  const processRequestAction = async (session: Session, type: RequestType, approve: boolean, reason = '', remark = ''): Promise<boolean> => {
    try {
      const eventData = session.event?._data || {};
      if (!approve && type === 'guild' && session.guildId && (session.event?.type === 'guild-added' || eventData.notice_type === 'group_increase')) {
        if (reason) {
          try { await session.bot.sendMessage(session.guildId, `将退出该群 ${reason}`); }
          catch (e) { logger.warn(`发送退群通知失败: ${e}`); }
        }
        try {
          if (session.onebot) await session.onebot.setGroupLeave(session.guildId, false);
          return true;
        } catch (e) { logger.error(`退出群组 ${session.guildId} 失败: ${e}`); return false; }
      }
      const flag = eventData.flag;
      if (!flag || !session.onebot) return false;
      if (type === 'friend') await session.onebot.setFriendAddRequest(flag, approve, remark);
      else await session.onebot.setGroupAddRequest(flag, eventData.sub_type ?? 'add', approve, approve ? '' : reason);
      return true;
    } catch (e) {
      logger.error(`请求处理失败: ${e}`);
      return false;
    }
  };

  /**
   * 发送通知
   */
  const sendRequestNotification = async (session: Session, type: RequestType, status: 'pending' | 'approved' | 'rejected', details: { requestNumber?: number; reason?: string } = {}) => {
    const { notifyTarget = '' } = config;
    if (!notifyTarget) return;
    const [targetType, targetId] = notifyTarget.split(':');
    if (!targetId || (targetType !== 'guild' && targetType !== 'private')) return;

    try {
      const eventData = session.event?._data || {};
      const user = session.userId ? await session.bot.getUser?.(session.userId)?.catch(() => null) : null;
      const userName = user?.name || session.userId || '未知用户';
      const guild = (type !== 'friend' && session.guildId) ? await session.bot.getGuild?.(session.guildId)?.catch(() => null) : null;
      const operator = eventData.operator_id && session.userId && eventData.operator_id.toString() !== session.userId
        ? await session.bot.getUser?.(eventData.operator_id.toString())?.catch(() => null) : null;

      const msgLines = [];
      if (user?.avatar) msgLines.push(`<image url="${user.avatar}"/>`);
      let requestTypeText = type === 'friend' ? '好友申请' : type === 'member' ? '加群请求' : '群组邀请';

      msgLines.push(`类型：${requestTypeText}`);
      if (type !== 'guild' || session.userId !== session.selfId) {
        msgLines.push(`用户：${userName}${session.userId ? `(${session.userId})` : ''}`);
      }
      if (operator) msgLines.push(`管理：${operator.name ? `${operator.name}(${eventData.operator_id})` : eventData.operator_id}`);
      if (guild) msgLines.push(`群组：${guild.name ? `${guild.name}(${session.guildId})` : session.guildId}`);
      if (eventData.comment) msgLines.push(`验证信息：${eventData.comment}`);

      const sendFunc = targetType === 'private'
        ? (m: string) => session.bot.sendPrivateMessage(targetId, m)
        : (m: string) => session.bot.sendMessage(targetId, m);

      await sendFunc(msgLines.join('\n'));
      if (status === 'pending' && details.requestNumber) {
        await sendFunc(`请回复以下命令处理请求 #${details.requestNumber}：\n通过[y/ya]${details.requestNumber} [备注] | 拒绝[n/na]${details.requestNumber} [理由]`);
      }
    } catch (e) { logger.error(`发送通知失败: ${e}`); }
  };

  /**
   * 自动处理检查
   */
  const shouldAutoAccept = async (session: Session, type: RequestType): Promise<boolean | string> => {
    const validationMessage = extractAnswers(session.event?._data?.comment);
    const parseRegex = (input: string) => {
      const slashMatch = input.match(/^\/(.+)\/([a-z]*)$/);
      if (slashMatch) return new RegExp(slashMatch[1], slashMatch[2]);
      return new RegExp(input, 'i');
    };

    switch (type) {
      case 'member': {
        const rule = (config.MemberRequestAutoRules || []).find(r => r.guildId === session.guildId);
        if (!rule) return false;
        if (rule.keyword) {
          try {
            if (!parseRegex(rule.keyword).test(validationMessage)) return false;
          } catch (e) { return false; }
        }
        if ((rule.minLevel ?? -1) >= 0 && session.onebot && session.userId) {
          try {
            const userInfo = await session.onebot.getStrangerInfo(session.userId, true) as OneBotUserInfo;
            if ((userInfo.qqLevel ?? 0) < rule.minLevel) return `QQ 等级低于${rule.minLevel}级`;
          } catch (e) { return false; }
        }
        return true;
      }
      case 'friend': {
        if (config.FriendRequestAutoRegex) {
          try {
            if (parseRegex(config.FriendRequestAutoRegex).test(validationMessage)) return true;
          } catch (e) {}
        }
        if ((config.FriendLevel ?? -1) >= 0 && session.onebot && session.userId) {
          try {
            const userInfo = await session.onebot.getStrangerInfo(session.userId, true) as OneBotUserInfo;
            if ((userInfo.qqLevel ?? 0) < config.FriendLevel!) return `QQ 等级低于${config.FriendLevel}级`;
            return true;
          } catch (e) { return false; }
        }
        return false;
      }
      case 'guild': {
        if (session.userId && (config.GuildAllowUsers || []).includes(session.userId)) return true;
        try {
          if (session.userId) {
            const user = await ctx.database.getUser(session.platform, session.userId);
            if (user && user.authority > 1) return true;
          }
        } catch {}
        if ((config.GuildMinMemberCount ?? -1) >= 0 || (config.GuildMaxCapacity ?? -1) >= 0) {
          if (session.onebot && session.guildId) {
            try {
              const info = await session.onebot.getGroupInfo(session.guildId, true) as OneBotGroupInfo;
              if (config.GuildMinMemberCount! >= 0 && info.member_count < config.GuildMinMemberCount!) return `群成员不足${config.GuildMinMemberCount}人`;
              if (config.GuildMaxCapacity! >= 0 && info.max_member_count < config.GuildMaxCapacity!) return `群容量不足${config.GuildMaxCapacity}`;
              return true;
            } catch (e) { return false; }
          }
        }
        return false;
      }
    }
  };

  /**
   * 设置手动处理
   */
  const setupManualHandling = async (session: Session, type: RequestType, requestId: string) => {
    const requestNumber = nextRequestNumber++;
    requestNumberMap.set(requestNumber, requestId);
    const activeRequest: ActiveRequest = { session, type, requestNumber };
    activeRequests.set(requestId, activeRequest);

    await sendRequestNotification(session, type, 'pending', { requestNumber });

    const timeoutMin = config.manualTimeout ?? 60;
    if (timeoutMin > 0) {
      activeRequest.timeoutTimer = setTimeout(async () => {
        if (!activeRequests.has(requestId)) return;
        cleanupActiveRequest(requestId);
        const action = config.manualTimeoutAction || 'accept';
        await processRequestAction(session, type, action === 'accept', action === 'reject' ? '处理超时自动拒绝' : '');
        const [tType, tId] = (config.notifyTarget || '').split(':');
        if (tId) {
          const send = tType === 'private' ? (m: string) => session.bot.sendPrivateMessage(tId, m) : (m: string) => session.bot.sendMessage(tId, m);
          await send(`请求 #${requestNumber} 超时，已自动${action === 'accept' ? '通过' : '拒绝'}`);
        }
      }, timeoutMin * 60 * 1000);
    }

    const [targetType, targetId] = (config.notifyTarget || '').split(':');
    if (!targetId) return;

    activeRequest.disposer = ctx.middleware(async (s, next) => {
      if (typeof s.content !== 'string') return next();
      if (targetType === 'private' ? s.userId !== targetId : s.guildId !== targetId) return next();

      const bulkMatch = s.content.trim().match(/^(ya|na|全部同意|全部拒绝)\s*(.*)$/);
      if (bulkMatch && activeRequests.size > 0) {
        const reqs = [...activeRequests.values()];
        activeRequests.clear();
        requestNumberMap.clear();
        const isApprove = bulkMatch[1] === 'ya' || bulkMatch[1] === '全部同意';
        const extra = bulkMatch[2]?.trim() || '';
        for (const r of reqs) {
          r.disposer?.();
          if (r.timeoutTimer) clearTimeout(r.timeoutTimer);
          await processRequestAction(r.session, r.type, isApprove, !isApprove ? extra : '', isApprove && r.type === 'friend' ? extra : '');
        }
        const send = targetType === 'private' ? (m: string) => s.bot.sendPrivateMessage(targetId, m) : (m: string) => s.bot.sendMessage(targetId, m);
        await send(`已${isApprove ? '通过' : '拒绝'} ${reqs.length} 个请求`);
        return;
      }

      const match = s.content.trim().match(new RegExp(`^(y|n|通过|拒绝)(${requestNumber})\\s*(.*)$`));
      if (!match) return next();

      cleanupActiveRequest(requestId);
      const isApprove = match[1] === 'y' || match[1] === '通过';
      const extra = match[3]?.trim() || '';
      const success = await processRequestAction(session, type, isApprove, !isApprove ? extra : '', isApprove && type === 'friend' ? extra : '');
      const send = targetType === 'private' ? (m: string) => s.bot.sendPrivateMessage(targetId, m) : (m: string) => s.bot.sendMessage(targetId, m);
      if (success) await send(`请求 #${requestNumber} 已${isApprove ? '通过' : '拒绝'}`);
      else await send(`处理请求 #${requestNumber} 失败`);
    });
  };

  /**
   * 处理请求
   */
  const processRequest = async (session: Session, type: RequestType) => {
    const flag = session.event?._data?.flag;
    if (flag) {
      if (processedFlags.has(flag)) return;
      processedFlags.add(flag);
      setTimeout(() => processedFlags.delete(flag!), 60000);
    }
    const requestKey = type === 'friend' ? `friend:${session.userId}` : type === 'guild' ? `guild:${session.guildId}` : `member:${session.userId}:${session.guildId}`;
    cleanupActiveRequest(requestKey);

    try {
      const autoResult = await shouldAutoAccept(session, type);
      if (autoResult === true) {
        await processRequestAction(session, type, true);
        await sendRequestNotification(session, type, 'approved');
      } else if (typeof autoResult === 'string') {
        await processRequestAction(session, type, false, autoResult);
        await sendRequestNotification(session, type, 'rejected', { reason: autoResult });
      } else {
        await setupManualHandling(session, type, requestKey);
      }
    } catch (e) { logger.error(`处理流程出错: ${e}`); }
  };

  // 注册监听
  if (config.enable !== false) {
    const handle = (type: RequestType) => async (session: Session) => {
      const data = session.event?._data || {};
      session.userId = data.user_id?.toString();
      if (type !== 'friend') session.guildId = data.group_id?.toString();
      await processRequest(session, type);
    };

    ctx.on('friend-request', handle('friend'));
    ctx.on('guild-request', handle('guild'));
    ctx.on('guild-member-request', handle('member'));
    ctx.on('guild-added', handle('guild'));
  }
}
