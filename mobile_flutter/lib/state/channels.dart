/// IPC + push channel names the phone uses — the subset of CHANNELS in
/// src/shared/ipc.ts that src/main/remote/router.ts allowlists for devices.
/// These strings are part of the wire contract; never rename them here.
library;

class Channels {
  // requests
  static const appGetInfo = 'app:getInfo';
  static const convList = 'conv:list';
  static const convCreate = 'conv:create';
  static const convGet = 'conv:get';
  static const convDelete = 'conv:delete';
  static const convMessages = 'conv:messages';
  static const chatSend = 'chat:send';
  static const chatStop = 'chat:stop';
  static const chatRegenerate = 'chat:regenerate';
  static const toolsApprovalRespond = 'tools:approval:respond';
  static const toolsQuestionRespond = 'tools:question:respond';

  // pushes
  static const streamEvent = 'push:streamEvent';
  static const toolApprovalRequest = 'push:toolApprovalRequest';
  static const toolApprovalSettled = 'push:toolApprovalSettled';
  static const userQuestionRequest = 'push:userQuestionRequest';
  static const userQuestionSettled = 'push:userQuestionSettled';
  static const conversationsChanged = 'push:conversationsChanged';
  static const mainNotice = 'push:mainNotice';
}
