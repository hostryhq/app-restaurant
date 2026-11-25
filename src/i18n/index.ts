import { createTranslator, en as uiEn, type Translator } from "@hostry/ui-kit";
import { en } from "./en";

export { en };

/** English now; Tamil and Malayalam catalogues are added here when the founder confirms them (keys are the contract). */
export function createAppTranslator(): Translator {
  return createTranslator({ en: { ...uiEn, ...en } });
}
