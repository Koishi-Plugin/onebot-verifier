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

type RequestKind = 'friend' | 'guild' | 'member'

interface UserInfo {
  user_id: number
  qqLevel?: number
}

interface GroupInfo {
  group_id: number
  group_name: string
  member_count: number
  max_member_count: number
}

interface Task {
  session: Session;
  kind: RequestKind;
  messages: string[];
  timer?: NodeJS.Timeout;
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

export function apply(ctx: Context, config: Config = {}) {
  const logger = new Logger('onebot-verifier');
  const tasks = new Map<string, Task>();

  // 执行操作
  const doAction = async (session: Session, kind: RequestKind, pass: boolean, reason = '', remark = ''): Promise<boolean> => {
    try {
      const data = session.event?._data || {};
      if (!pass && kind === 'guild' && session.guildId && (session.event?.type === 'guild-added' || data.notice_type === 'group_increase')) {
        if (reason) {
          try { await session.bot.sendMessage(session.guildId, `将退出该群：${reason}`); }
          catch (error) { logger.warn(`发送提醒失败: ${error}`); }
        }
        try {
          await session.onebot?.setGroupLeave(session.guildId, false);
          return true;
        } catch (error) { logger.error(`退出群组 ${session.guildId} 失败: ${error}`); return false; }
      }
      if (!data.flag || !session.onebot) return false;
      if (kind === 'friend') await session.onebot.setFriendAddRequest(data.flag, pass, remark);
      else await session.onebot.setGroupAddRequest(data.flag, data.sub_type ?? 'add', pass, pass ? '' : reason);
      return true;
    } catch (error) {
      logger.error(`请求操作失败: ${error}`);
      return false;
    }
  };

  // 发送通知
  const notify = async (session: Session, kind: RequestKind): Promise<string[]> => {
    const target = config.notifyTarget || '';
    if (!target) return [];
    const [type, id] = target.split(':');
    if (!id || (type !== 'guild' && type !== 'private')) return [];
    try {
      const data = session.event?._data || {};
      const user = session.userId ? await session.bot.getUser?.(session.userId)?.catch(() => null) : null;
      const guild = (kind !== 'friend' && session.guildId) ? await session.bot.getGuild?.(session.guildId)?.catch(() => null) : null;
      const admin = data.operator_id && session.userId && data.operator_id.toString() !== session.userId
        ? await session.bot.getUser?.(data.operator_id.toString())?.catch(() => null) : null;

      const lines = [];
      if (user?.avatar) lines.push(`<image url="${user.avatar}"/>`);
      const typeName = kind === 'friend' ? '好友申请' : kind === 'member' ? '加群请求' : '群组邀请';
      lines.push(`类型：${typeName}`);
      if (kind !== 'guild' || session.userId !== session.selfId) lines.push(`用户：${user?.name || session.userId}${session.userId ? `(${session.userId})` : ''}`);
      if (admin) lines.push(`管理：${admin.name ? `${admin.name}(${data.operator_id})` : data.operator_id}`);
      if (guild) lines.push(`群组：${guild.name ? `${guild.name}(${session.guildId})` : session.guildId}`);
      if (data.comment) lines.push(`验证信息：${data.comment}`);

      const text = lines.join('\n');
      return await (type === 'private' ? session.bot.sendPrivateMessage(id, text) : session.bot.sendMessage(id, text)) || [];
    } catch (error) {
      logger.error(`发送通知失败: ${error}`);
      return [];
    }
  };

  // 自动处理
  const checkAuto = async (session: Session, kind: RequestKind): Promise<boolean | string> => {
    const raw = session.event?._data?.comment || '';
    const lines = raw.split(/[\r\n]+/)
      .map((s: string) => s.trim())
      .filter((s: string) => /^(回答)[:：]/i.test(s))
      .map((s: string) => s.replace(/^(回答)[:：]\s*/i, ''));
    const answer = lines.length > 0 ? lines.join('\n') : raw;

    const makeRegex = (text: string) => {
      const match = text.match(/^\/(.+)\/([a-z]*)$/);
      return match ? new RegExp(match[1], match[2]) : new RegExp(text, 'i');
    };

    if (kind === 'member') {
      const rule = config.MemberRequestAutoRules?.find(rule => rule.guildId === session.guildId);
      if (!rule) return false;
      try {
        if (rule.keyword && !makeRegex(rule.keyword).test(answer)) return false;
        if ((rule.minLevel ?? -1) >= 0 && session.onebot && session.userId) {
          const info = await session.onebot.getStrangerInfo(session.userId, true) as UserInfo;
          if ((info.qqLevel ?? 0) < rule.minLevel) return `QQ 等级低于${rule.minLevel}级`;
        }
      } catch { return false; }
      return true;
    }

    if (kind === 'friend') {
      try {
        if (config.FriendRequestAutoRegex && makeRegex(config.FriendRequestAutoRegex).test(answer)) return true;
        if ((config.FriendLevel ?? -1) >= 0 && session.onebot && session.userId) {
          const info = await session.onebot.getStrangerInfo(session.userId, true) as UserInfo;
          if ((info.qqLevel ?? 0) < config.FriendLevel!) return `QQ 等级低于${config.FriendLevel}级`;
          return true;
        }
      } catch { return false; }
      return false;
    }

    if (kind === 'guild') {
      if (session.userId && config.GuildAllowUsers?.includes(session.userId)) return true;
      try {
        const user = session.userId ? await ctx.database.getUser(session.platform, session.userId) : null;
        if (user && user.authority > 1) return true;
      } catch {}
      if (session.onebot && session.guildId && ((config.GuildMinMemberCount ?? -1) >= 0 || (config.GuildMaxCapacity ?? -1) >= 0)) {
        try {
          const info = await session.onebot.getGroupInfo(session.guildId, true) as GroupInfo;
          if (config.GuildMinMemberCount! >= 0 && info.member_count < config.GuildMinMemberCount!) return `群成员不足${config.GuildMinMemberCount}人`;
          if (config.GuildMaxCapacity! >= 0 && info.max_member_count < config.GuildMaxCapacity!) return `群容量不足${config.GuildMaxCapacity}人`;
          return true;
        } catch { return false; }
      }
      return false;
    }
    return false;
  };

  // 手动处理
  const setManual = async (session: Session, kind: RequestKind) => {
    const messages = await notify(session, kind);
    if (!messages?.length) return;

    const task: Task = { session, kind, messages };
    messages.forEach(id => tasks.set(id, task));

    const limit = config.manualTimeout ?? 60;
    if (limit > 0) {
      task.timer = setTimeout(async () => {
        if (!tasks.has(messages[0])) return;
        messages.forEach(id => tasks.delete(id));

        const action = config.manualTimeoutAction || 'accept';
        const pass = action === 'accept';
        await doAction(session, kind, pass, pass ? '' : '等待超时，自动拒绝');

        const target = config.notifyTarget || '';
        const [type, id] = target.split(':');
        if (id) {
          const text = `等待超时，已自动${pass ? '通过' : '拒绝'}`;
          await (type === 'private' ? session.bot.sendPrivateMessage(id, text) : session.bot.sendMessage(id, text));
        }
      }, limit * 60000);
    }
  };

  // 处理请求
  const process = async (session: Session, kind: RequestKind) => {
    try {
      const result = await checkAuto(session, kind);
      if (result === true) {
        await doAction(session, kind, true);
        await notify(session, kind);
      } else if (typeof result === 'string') {
        await doAction(session, kind, false, result);
        await notify(session, kind);
      } else {
        await setManual(session, kind);
      }
    } catch (error) { logger.error(`处理请求出错: ${error}`); }
  };

  // 注册中间件
  if (config.enable !== false) {
    const bind = (kind: RequestKind) => async (session: Session) => {
      const data = session.event?._data || {};
      session.userId = data.user_id?.toString();
      if (kind !== 'friend') session.guildId = data.group_id?.toString();
      await process(session, kind);
    };

    ctx.on('friend-request', bind('friend'));
    ctx.on('guild-request', bind('guild'));
    ctx.on('guild-member-request', bind('member'));
    ctx.on('guild-added', bind('guild'));

    ctx.middleware(async (session, next) => {
      if (typeof session.content !== 'string' || !session.quote?.id) return next();
      const task = tasks.get(session.quote.id);
      if (!task) return next();

      const target = config.notifyTarget || '';
      const [type, id] = target.split(':');
      if (type === 'private' ? session.userId !== id : session.guildId !== id) return next();

      const text = session.content.replace(/<(quote|at)\s+[^>]*\/>/gi, '').trim();
      const match = text.match(/^(y|n|通过|拒绝)(?:\s+(.*))?$/);
      if (!match) return next();

      if (task.timer) clearTimeout(task.timer);
      task.messages.forEach(msg => tasks.delete(msg));

      const pass = match[1] === 'y' || match[1] === '通过';
      const extra = match[2]?.trim() || '';
      const ok = await doAction(task.session, task.kind, pass, pass ? '' : extra, pass && task.kind === 'friend' ? extra : '');

      const reply = ok ? `已${pass ? '通过' : '拒绝'}该请求` : `处理该请求时出错`;
      await (type === 'private' ? session.bot.sendPrivateMessage(id, reply) : session.bot.sendMessage(id, reply));
    });
  }
}
