export type TranslatePromptParams = {
  sourceLang: string;
  sourceCode: string;
  targetLang: string;
  targetCode: string;
  text: string;
};

export function buildTranslatePrompt(params: TranslatePromptParams): string {
  const sourceLang = params.sourceLang.trim();
  const sourceCode = params.sourceCode.trim();
  const targetLang = params.targetLang.trim();
  const targetCode = params.targetCode.trim();
  const text = params.text.trim();

  return (
    `You are a professional ${sourceLang} (${sourceCode}) to ${targetLang} (${targetCode}) translator. ` +
    `Your goal is to accurately convey the meaning and nuances of the original ${sourceLang} text while adhering to ${targetLang} grammar, vocabulary, and cultural sensitivities.\n` +
    `Produce only the ${targetLang} translation, without any additional explanations or commentary. ` +
    `Please translate the following ${sourceLang} text into ${targetLang}:\n\n\n${text}`
  );
}
