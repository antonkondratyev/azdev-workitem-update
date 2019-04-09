import * as tl from 'azure-pipelines-task-lib';
import * as azdev from 'azure-devops-node-api';
import * as vss from 'azure-devops-node-api/interfaces/common/VSSInterfaces';
import { BuildApi } from 'azure-devops-node-api/BuildApi';
import { IWorkItemTrackingApi } from 'azure-devops-node-api/WorkItemTrackingApi';
import { WorkItem } from 'azure-devops-node-api/interfaces/WorkItemTrackingInterfaces';
import InputVariable from './InputVariable';
import BuildVariable from './BuildVariable';
import TaskVariable from './TaskVariable';
import AuthenticationProvider from './AuthenticationProvider';

async function main(): Promise<void> {
    try {
        let variables: TaskVariable = new TaskVariable();
        variables.load();

        let azdevAuth: AuthenticationProvider = new AuthenticationProvider(variables.system);
        let connection: azdev.WebApi = azdevAuth.getConnection();

        let buildApi: BuildApi = await connection.getBuildApi();
        let buildWIRefs: vss.ResourceRef[] = await buildApi.getBuildWorkItemsRefs(variables.system.teamProject, variables.build.buildId, 1000);
        let wiApi: IWorkItemTrackingApi = await connection.getWorkItemTrackingApi();

        if (buildWIRefs.length !== 0) {
            console.log(`Associated work items count: ${buildWIRefs.length}`);

            let wiTypeCount: number = 0;
            let workItemsId: number[] = buildWIRefs.map(wiRefsId => Number(wiRefsId.id));
            let workItems: WorkItem[] = await wiApi.getWorkItems(workItemsId, [
                'System.WorkItemType',
                'System.State',
                'System.Reason',
                'System.CreatedBy',
                'System.AssignedTo'
            ]);

            workItems.filter(wi => wi.fields['System.WorkItemType'] === variables.input.workItemType ? wi.id : false)
                .forEach(wi => {
                    if (wi.fields['System.State'] === variables.input.stateFrom && wi.fields['System.Reason'] === variables.input.reasonFrom) {
                        let wiPatch: vss.JsonPatchDocument & vss.JsonPatchOperation[] = createWorkItemPatch(wi, variables.build, variables.input);
                        updateWorkItem(wi, wiPatch, wiApi);
                    }
                    wiTypeCount++;
                });

            if (wiTypeCount === 0) {
                console.log(`No match work item type '${variables.input.workItemType}'`);
            }
        } else {
            console.log('No associated work items found for this build.');
        }
    }
    catch (err) {
        tl.setResult(tl.TaskResult.SucceededWithIssues, err);
    }
}

function createWorkItemPatch(currentWorkItem: WorkItem, build: BuildVariable, inputs: InputVariable): vss.JsonPatchDocument & vss.JsonPatchOperation[] {
    let newState: string = inputs.stateTo;
    let newReason: string = inputs.reasonTo;
    let jsonPatch: vss.JsonPatchDocument & vss.JsonPatchOperation[] = [
        {
            op: vss.Operation.Add,
            path: '/fields/System.State',
            value: `${newState}`
        } as vss.JsonPatchOperation,
        {
            op: vss.Operation.Add,
            path: '/fields/System.Reason',
            value: `${newReason}`
        } as vss.JsonPatchOperation,
        {
            op: vss.Operation.Add,
            path: '/fields/System.History',
            value: `Automatic change of state from <b>${inputs.stateFrom}</b> to <b>${newState}</b> because the build <b>${build.definitionName} [ ${build.buildNumber} ]</b> is completed successfully.`
        } as vss.JsonPatchOperation
    ];

    if (inputs.assignedToCreator) {
        jsonPatch.push({
            op: vss.Operation.Add,
            path: '/fields/System.AssignedTo',
            value: currentWorkItem.fields['System.CreatedBy']
        } as vss.JsonPatchOperation);
    }

    if (inputs.linkToBuild) {
        // TODO: Check if the link exists before creating
        jsonPatch.push({
            op: vss.Operation.Add,
            path: '/relations/-',
            value: {
                rel: 'ArtifactLink',
                url: `vstfs:///Build/Build/${build.buildId}`,
                attributes: {
                    name: 'Build',
                    comment: 'Automatically make a new link for the dependency.'
                }
            }
        } as vss.JsonPatchOperation);
    }

    return jsonPatch;
}

async function updateWorkItem(workItem: WorkItem, workItemPatch: vss.JsonPatchDocument & vss.JsonPatchOperation[], wiApi: IWorkItemTrackingApi): Promise<void> {
    await wiApi.updateWorkItem(null, workItemPatch, workItem.id)
        .then(wi => console.log(`Work Item ${wi.id} was updated.`))
        .catch(err => tl.setResult(tl.TaskResult.SucceededWithIssues, err));
}

main();