export type WorkflowScene={id:string;index:number;startTime:number;endTime:number;duration:number;eventType:string;description:string;sourcePrepared:boolean;status:string;round:number;detail:string};
export type WorkflowProgress={version:number;phase:string;steps:{id:string;number:number;title:string;detail:string;status:string}[];scenes:WorkflowScene[];sections?:{index:number;startTime:number;endTime:number;targetSeconds:number;sceneCount:number;selectedSeconds:number}[];sourceVerifiedCount?:number;sourceVerifiedDuration?:number;selectedCount:number;sourcePrepared:number;verified:number;selectedDuration:number;sourceDuration:number;waiting:boolean;retryAt:string|null;waitingReason:string|null};
export const WORKFLOW_STEPS:{id:string;title:string;detail:string}[];
export function workflowPhase(job?:object):string;
export function buildWorkflowProgress(job?:object):WorkflowProgress;
