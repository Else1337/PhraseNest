import { looseExpressionParts, expressionKind } from "./library-expression";
import { documentRoles, type DialogueWorkspace } from "./dialogue-model";
export { splitLooseExpression } from "./library-expression";
export function consolidateLooseExpressions(state: DialogueWorkspace) {
  return state.documents.flatMap((doc) => looseExpressionParts({ ...doc, role: documentRoles[doc.role], kind: "document" }).map(({ value, meaning }) => ({ type: expressionKind(value) === "sentence" ? "material" as const : "vocabulary" as const, value, meaning, sourceType: "manual" as const, sourceId: doc.id, sourceTitle: doc.title, note: "由零散资料自动归并；原文保留，不代表已掌握" })));
}
