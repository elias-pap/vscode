/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IProcessEnvironment, isWindows } from 'vs/base/common/platform';
import { EnvironmentVariableMutatorType, IEnvironmentVariableCollection, IExtensionOwnedEnvironmentVariableMutator, IMergedEnvironmentVariableCollection, IMergedEnvironmentVariableCollectionDiff } from 'vs/platform/terminal/common/environmentVariable';
import { IWorkspaceFolder } from 'vs/platform/workspace/common/workspace';

type VariableResolver = (str: string) => Promise<string>;

// const mutatorTypeToLabelMap: Map<EnvironmentVariableMutatorType, string> = new Map([
// 	[EnvironmentVariableMutatorType.Append, 'APPEND'],
// 	[EnvironmentVariableMutatorType.Prepend, 'PREPEND'],
// 	[EnvironmentVariableMutatorType.Replace, 'REPLACE']
// ]);

export class MergedEnvironmentVariableCollection implements IMergedEnvironmentVariableCollection {
	/**
	 * Using variable as keys is okay here because each terminal instance has its own set of variables.
	 * @karrtikr TODO: Rename it back to map.
	 */
	readonly variableMap: Map<string, IExtensionOwnedEnvironmentVariableMutator[]> = new Map();

	constructor(
		readonly collections: ReadonlyMap<string, IEnvironmentVariableCollection>,
		/**
		 * @karrtikr TODO: Change it back to private.
		 */
		public readonly owningWorkspace: IWorkspaceFolder | undefined
	) {
		collections.forEach((collection, extensionIdentifier) => {
			const it = collection.map.entries();
			let next = it.next();
			while (!next.done) {
				const mutator = next.value[1];
				const variable = mutator.variable;
				let entry = this.variableMap.get(variable);
				if (this.owningWorkspace) {
					// If a mutator is scoped to a workspace folder, only apply it if the workspace
					// folder matches.
					if (mutator.scope?.workspaceFolder && mutator.scope.workspaceFolder.uri.fsPath !== this.owningWorkspace.uri.fsPath) {
						next = it.next();
						continue;
					}
				}
				if (!entry) {
					entry = [];
					this.variableMap.set(variable, entry);
				}

				// If the first item in the entry is replace ignore any other entries as they would
				// just get replaced by this one.
				if (entry.length > 0 && entry[0].type === EnvironmentVariableMutatorType.Replace) {
					next = it.next();
					continue;
				}

				// Mutators get applied in the reverse order than they are created
				entry.unshift({
					extensionIdentifier,
					value: mutator.value,
					type: mutator.type,
					scope: mutator.scope,
					variable: mutator.variable
				});

				next = it.next();
			}
		});
	}

	async applyToProcessEnvironment(env: IProcessEnvironment, variableResolver?: VariableResolver): Promise<void> {
		let lowerToActualVariableNames: { [lowerKey: string]: string | undefined } | undefined;
		if (isWindows) {
			lowerToActualVariableNames = {};
			Object.keys(env).forEach(e => lowerToActualVariableNames![e.toLowerCase()] = e);
		}
		for (const [variable, mutators] of this.variableMap) {
			const actualVariable = isWindows ? lowerToActualVariableNames![variable.toLowerCase()] || variable : variable;
			for (const mutator of mutators) {
				const value = variableResolver ? await variableResolver(mutator.value) : mutator.value;
				// if (mutator.timing === EnvironmentVariableMutatorTiming.AfterShellIntegration) {
				// 	const key = `VSCODE_ENV_${mutatorTypeToLabelMap.get(mutator.type)!}`;
				// 	env[key] = (env[key] ? env[key] + ':' : '') + variable + '=' + value;
				// 	continue;
				// }
				switch (mutator.type) {
					case EnvironmentVariableMutatorType.Append:
						env[actualVariable] = (env[actualVariable] || '') + value;
						break;
					case EnvironmentVariableMutatorType.Prepend:
						env[actualVariable] = value + (env[actualVariable] || '');
						break;
					case EnvironmentVariableMutatorType.Replace:
						env[actualVariable] = value;
						break;
				}
			}
		}
	}

	diff(other: IMergedEnvironmentVariableCollection): IMergedEnvironmentVariableCollectionDiff | undefined {
		const added: Map<string, IExtensionOwnedEnvironmentVariableMutator[]> = new Map();
		const changed: Map<string, IExtensionOwnedEnvironmentVariableMutator[]> = new Map();
		const removed: Map<string, IExtensionOwnedEnvironmentVariableMutator[]> = new Map();

		// Find added
		other.variableMap.forEach((otherMutators, variable) => {
			const currentMutators = this.variableMap.get(variable);
			const result = getMissingMutatorsFromArray(otherMutators, currentMutators);
			if (result) {
				added.set(variable, result);
			}
		});

		// Find removed
		this.variableMap.forEach((currentMutators, variable) => {
			const otherMutators = other.variableMap.get(variable);
			const result = getMissingMutatorsFromArray(currentMutators, otherMutators);
			if (result) {
				removed.set(variable, result);
			}
		});

		// Find changed
		this.variableMap.forEach((currentMutators, variable) => {
			const otherMutators = other.variableMap.get(variable);
			const result = getChangedMutatorsFromArray(currentMutators, otherMutators);
			if (result) {
				changed.set(variable, result);
			}
		});

		if (added.size === 0 && changed.size === 0 && removed.size === 0) {
			return undefined;
		}

		return { added, changed, removed };
	}
}

function getMissingMutatorsFromArray(
	current: IExtensionOwnedEnvironmentVariableMutator[],
	other: IExtensionOwnedEnvironmentVariableMutator[] | undefined
): IExtensionOwnedEnvironmentVariableMutator[] | undefined {
	// If it doesn't exist, all are removed
	if (!other) {
		return current;
	}

	// Create a map to help
	const otherMutatorExtensions = new Set<string>();
	other.forEach(m => otherMutatorExtensions.add(m.extensionIdentifier));

	// Find entries removed from other
	const result: IExtensionOwnedEnvironmentVariableMutator[] = [];
	current.forEach(mutator => {
		if (!otherMutatorExtensions.has(mutator.extensionIdentifier)) {
			result.push(mutator);
		}
	});

	return result.length === 0 ? undefined : result;
}

function getChangedMutatorsFromArray(
	current: IExtensionOwnedEnvironmentVariableMutator[],
	other: IExtensionOwnedEnvironmentVariableMutator[] | undefined
): IExtensionOwnedEnvironmentVariableMutator[] | undefined {
	// If it doesn't exist, none are changed (they are removed)
	if (!other) {
		return undefined;
	}

	// Create a map to help
	const otherMutatorExtensions = new Map<string, IExtensionOwnedEnvironmentVariableMutator>();
	other.forEach(m => otherMutatorExtensions.set(m.extensionIdentifier, m));

	// Find entries that exist in both but are not equal
	const result: IExtensionOwnedEnvironmentVariableMutator[] = [];
	current.forEach(mutator => {
		const otherMutator = otherMutatorExtensions.get(mutator.extensionIdentifier);
		if (otherMutator && (mutator.type !== otherMutator.type || mutator.value !== otherMutator.value || mutator.scope?.workspaceFolder?.index !== otherMutator.scope?.workspaceFolder?.index)) {
			// Return the new result, not the old one
			result.push(otherMutator);
		}
	});

	return result.length === 0 ? undefined : result;
}
