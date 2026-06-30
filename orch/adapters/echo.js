// 测试用假适配器，不烧 token。prompt 含 FAIL 视为失败，用于测 loop。
module.exports = {
  async run({ prompt, onLine }) {
    onLine(prompt);
    return { output: prompt, success: !prompt.includes('FAIL') };
  },
};
