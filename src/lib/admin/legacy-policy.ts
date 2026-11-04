import { currentModelScope } from "./model-scope";
import { PolicyFrame,PolicyFrameError,policyInstruction,recordPolicy,policyInputHash,policyCategory,UsagePolicyError } from "./policy";
export function legacyPolicy(json:boolean){
 const context=currentModelScope();if(!context?.policyQuestion||!context.turnId)return null;
 const classify=async(category:typeof policyCategory._output)=>{const d=await recordPolicy(context.studentId,context.turnId!,context.policyHash??policyInputHash(context.policyQuestion),category);context.policyDecision=d;if(!d.allowed)throw new UsagePolicyError(d);return d;};
 const frame=new PolicyFrame({accept:classify});
 return {
  instruction:json?`${policyInstruction} 本次改用 JSON 协议：不要 pn-policy 标签，在输出 JSON 顶层加 "pn_policy":"分类枚举"。若不允许，只返回该字段。分类只针对当前学生请求：${context.policyQuestion}`:`${policyInstruction}\n当前学生请求：${context.policyQuestion}`,
  frame:{async push(text:string){try{return await frame.push(text);}catch(error){context.policyFailure=error instanceof Error?error:new PolicyFrameError();throw error;}},assertReady(){try{frame.assertReady();}catch(error){context.policyFailure=error instanceof Error?error:new PolicyFrameError();throw error;}}},
  async parse(content:string){try{if(!json){const frame=new PolicyFrame({accept:classify}),visible=await frame.push(content);frame.assertReady();return visible;}
    let object:Record<string,unknown>;try{object=JSON.parse(content);if(!object||typeof object!=="object"||Array.isArray(object))throw new Error();}catch{throw new PolicyFrameError();}
    const category=policyCategory.safeParse(object.pn_policy);if(!category.success)throw new PolicyFrameError();await classify(category.data);delete object.pn_policy;return JSON.stringify(object);
   }catch(error){context.policyFailure=error instanceof Error?error:new PolicyFrameError();throw error;}
  }
 };
}
