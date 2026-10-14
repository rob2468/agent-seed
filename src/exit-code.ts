export const EXIT_CODE = {
  SUCCESS: 0,
  ERROR: 1, // 参数、文件访问或模型连接等执行异常。
  CANCELLED: 130, // 单次任务被用户取消。
  MODEL_CALL_LIMIT: 2, // 达到模型请求次数上限，尚未获得最终回答。
} as const;
