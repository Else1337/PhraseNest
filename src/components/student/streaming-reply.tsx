"use client";
import {useEffect,useSyncExternalStore} from "react";
import type {LiveReplyStore} from "@/lib/student/live-reply";
import {RichBoardText} from "@/components/ui/rich-board-text";
export function StreamingReply({store,onLayout}:{store:LiveReplyStore;onLayout:()=>void}){
  const content=useSyncExternalStore(store.subscribe,store.snapshot,()=>"");
  useEffect(()=>{if(content)onLayout();},[content,onLayout]);
  return content?<RichBoardText content={content} streaming/>:null;
}
