/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as editorCommon from 'vs/editor/common/editorCommon';
import { ViewPart } from 'vs/editor/browser/view/viewPart';
import { ViewContext } from 'vs/editor/common/view/viewContext';
import { RenderingContext, RestrictedRenderingContext } from 'vs/editor/common/view/renderingContext';
import { Position } from 'vs/editor/common/core/position';
import { TokenizationRegistry } from 'vs/editor/common/modes';
import { IDisposable } from 'vs/base/common/lifecycle';
import * as viewEvents from 'vs/editor/common/view/viewEvents';
import { editorOverviewRulerBorder, editorCursorForeground } from 'vs/editor/common/view/editorColorRegistry';
import { Color } from 'vs/base/common/color';
import { ITheme, ThemeColor } from 'vs/platform/theme/common/themeService';
import { FastDomNode, createFastDomNode } from 'vs/base/browser/fastDomNode';
import { ModelDecorationOverviewRulerOptions } from 'vs/editor/common/model/textModelWithDecorations';

class Settings {

	public readonly lineHeight: number;
	public readonly pixelRatio: number;
	public readonly overviewRulerLanes: number;

	public readonly renderBorder: boolean;
	public readonly borderColor: string;

	public readonly hideCursor: boolean;
	public readonly cursorColor: string;

	public readonly themeType: 'light' | 'dark' | 'hc';
	public readonly backgroundColor: string;

	public readonly top: number;
	public readonly right: number;
	public readonly domWidth: number;
	public readonly domHeight: number;
	public readonly canvasWidth: number;
	public readonly canvasHeight: number;

	public readonly x: number[];
	public readonly w: number[];

	constructor(config: editorCommon.IConfiguration, theme: ITheme) {
		this.lineHeight = config.editor.lineHeight;
		this.pixelRatio = config.editor.pixelRatio;
		this.overviewRulerLanes = config.editor.viewInfo.overviewRulerLanes;

		this.renderBorder = config.editor.viewInfo.overviewRulerBorder;
		const borderColor = theme.getColor(editorOverviewRulerBorder);
		this.borderColor = borderColor ? borderColor.toString() : null;

		this.hideCursor = config.editor.viewInfo.hideCursorInOverviewRuler;
		const cursorColor = theme.getColor(editorCursorForeground);
		this.cursorColor = cursorColor ? cursorColor.transparent(0.7).toString() : null;

		this.themeType = theme.type;

		const minimapEnabled = config.editor.viewInfo.minimap.enabled;
		const backgroundColor = (minimapEnabled ? TokenizationRegistry.getDefaultBackground() : null);
		this.backgroundColor = (backgroundColor ? Color.Format.CSS.formatHex(backgroundColor) : null);

		const position = config.editor.layoutInfo.overviewRuler;
		this.top = position.top;
		this.right = position.right;
		this.domWidth = position.width;
		this.domHeight = position.height;
		this.canvasWidth = (this.domWidth * this.pixelRatio) | 0;
		this.canvasHeight = (this.domHeight * this.pixelRatio) | 0;

		const [x, w] = this._initLanes(1, this.canvasWidth, this.overviewRulerLanes);
		this.x = x;
		this.w = w;
	}

	private _initLanes(canvasLeftOffset: number, canvasWidth: number, laneCount: number): [number[], number[]] {
		const remainingWidth = canvasWidth - canvasLeftOffset;

		if (laneCount >= 3) {
			const leftWidth = Math.floor(remainingWidth / 3);
			const rightWidth = Math.floor(remainingWidth / 3);
			const centerWidth = remainingWidth - leftWidth - rightWidth;
			const leftOffset = canvasLeftOffset;
			const centerOffset = leftOffset + leftWidth;
			const rightOffset = leftOffset + leftWidth + centerWidth;

			return [
				[
					0,
					leftOffset, // Left
					centerOffset, // Center
					leftOffset, // Left | Center
					rightOffset, // Right
					leftOffset, // Left | Right
					centerOffset, // Center | Right
					leftOffset, // Left | Center | Right
				], [
					0,
					leftWidth, // Left
					centerWidth, // Center
					leftWidth + centerWidth, // Left | Center
					rightWidth, // Right
					leftWidth + centerWidth + rightWidth, // Left | Right
					centerWidth + rightWidth, // Center | Right
					leftWidth + centerWidth + rightWidth, // Left | Center | Right
				]
			];
		} else if (laneCount === 2) {
			const leftWidth = Math.floor(remainingWidth / 2);
			const rightWidth = remainingWidth - leftWidth;
			const leftOffset = canvasLeftOffset;
			const rightOffset = leftOffset + leftWidth;

			return [
				[
					0,
					leftOffset, // Left
					leftOffset, // Center
					leftOffset, // Left | Center
					rightOffset, // Right
					leftOffset, // Left | Right
					leftOffset, // Center | Right
					leftOffset, // Left | Center | Right
				], [
					0,
					leftWidth, // Left
					leftWidth, // Center
					leftWidth, // Left | Center
					rightWidth, // Right
					leftWidth + rightWidth, // Left | Right
					leftWidth + rightWidth, // Center | Right
					leftWidth + rightWidth, // Left | Center | Right
				]
			];
		} else {
			const offset = canvasLeftOffset;
			const width = remainingWidth;

			return [
				[
					0,
					offset, // Left
					offset, // Center
					offset, // Left | Center
					offset, // Right
					offset, // Left | Right
					offset, // Center | Right
					offset, // Left | Center | Right
				], [
					0,
					width, // Left
					width, // Center
					width, // Left | Center
					width, // Right
					width, // Left | Right
					width, // Center | Right
					width, // Left | Center | Right
				]
			];
		}
	}

	public equals(other: Settings): boolean {
		return (
			this.lineHeight === other.lineHeight
			&& this.pixelRatio === other.pixelRatio
			&& this.overviewRulerLanes === other.overviewRulerLanes
			&& this.renderBorder === other.renderBorder
			&& this.borderColor === other.borderColor
			&& this.hideCursor === other.hideCursor
			&& this.cursorColor === other.cursorColor
			&& this.themeType === other.themeType
			&& this.backgroundColor === other.backgroundColor
			&& this.top === other.top
			&& this.right === other.right
			&& this.domWidth === other.domWidth
			&& this.domHeight === other.domHeight
			&& this.canvasWidth === other.canvasWidth
			&& this.canvasHeight === other.canvasHeight
		);
	}
}

const enum Constants {
	MIN_DECORATION_HEIGHT = 6
}

const enum OverviewRulerLane {
	Left = 1,
	Center = 2,
	Right = 4,
	Full = 7
}

export class DecorationsOverviewRuler2 extends ViewPart {

	private readonly _tokensColorTrackerListener: IDisposable;
	private readonly _domNode: FastDomNode<HTMLCanvasElement>;
	private _settings: Settings;
	private _cursorPositions: Position[];

	constructor(context: ViewContext) {
		super(context);

		this._domNode = createFastDomNode(document.createElement('canvas'));
		this._domNode.setClassName('decorationsOverviewRuler');
		this._domNode.setPosition('absolute');
		this._domNode.setLayerHinting(true);

		this._settings = null;
		this._updateSettings(false);

		this._tokensColorTrackerListener = TokenizationRegistry.onDidChange((e) => {
			if (e.changedColorMap) {
				this._updateSettings(true);
			}
		});

		this._cursorPositions = [];
	}

	public dispose(): void {
		super.dispose();
		this._tokensColorTrackerListener.dispose();
	}

	private _updateSettings(renderNow: boolean): boolean {
		const newSettings = new Settings(this._context.configuration, this._context.theme);
		if (this._settings !== null && this._settings.equals(newSettings)) {
			// nothing to do
			return false;
		}

		this._settings = newSettings;

		this._domNode.setTop(this._settings.top);
		this._domNode.setRight(this._settings.right);
		this._domNode.setWidth(this._settings.domWidth);
		this._domNode.setHeight(this._settings.domHeight);
		this._domNode.domNode.width = this._settings.canvasWidth;
		this._domNode.domNode.height = this._settings.canvasHeight;

		if (renderNow) {
			this._render();
		}

		return true;
	}

	// ---- begin view event handlers

	public onConfigurationChanged(e: viewEvents.ViewConfigurationChangedEvent): boolean {
		return this._updateSettings(false);
	}
	public onCursorStateChanged(e: viewEvents.ViewCursorStateChangedEvent): boolean {
		this._cursorPositions = [];
		for (let i = 0, len = e.selections.length; i < len; i++) {
			this._cursorPositions[i] = e.selections[i].getPosition();
		}
		return true;
	}
	public onDecorationsChanged(e: viewEvents.ViewDecorationsChangedEvent): boolean {
		return true;
	}
	public onFlushed(e: viewEvents.ViewFlushedEvent): boolean {
		return true;
	}
	public onScrollChanged(e: viewEvents.ViewScrollChangedEvent): boolean {
		return e.scrollHeightChanged;
	}
	public onZonesChanged(e: viewEvents.ViewZonesChangedEvent): boolean {
		return true;
	}
	public onThemeChanged(e: viewEvents.ViewThemeChangedEvent): boolean {
		// invalidate color cache
		const decorations = this._context.model.getAllOverviewRulerDecorations();
		for (let i = 0, len = decorations.length; i < len; i++) {
			const decoration = decorations[i];
			const opts = <ModelDecorationOverviewRulerOptions>decoration.source.options.overviewRuler;
			opts._resolvedColor = null;
		}
		return this._updateSettings(false);
	}

	// ---- end view event handlers

	public getDomNode(): HTMLElement {
		return this._domNode.domNode;
	}

	public prepareRender(ctx: RenderingContext): void {
		// Nothing to read
	}

	public render(editorCtx: RestrictedRenderingContext): void {
		this._render();
	}

	private _render(): void {
		const canvasWidth = this._settings.canvasWidth;
		const canvasHeight = this._settings.canvasHeight;
		const lineHeight = this._settings.lineHeight;
		const viewLayout = this._context.viewLayout;
		const theme = this._context.theme;
		const outerHeight = this._context.viewLayout.getScrollHeight();
		const heightRatio = canvasHeight / outerHeight;
		const decorations = this._context.model.getAllOverviewRulerDecorations();

		const minDecorationHeight = (Constants.MIN_DECORATION_HEIGHT * this._settings.pixelRatio) | 0;
		const halfMinDecorationHeight = (minDecorationHeight / 2) | 0;

		const canvasCtx = this._domNode.domNode.getContext('2d');
		if (this._settings.backgroundColor === null) {
			canvasCtx.clearRect(0, 0, canvasWidth, canvasHeight);
		} else {
			canvasCtx.fillStyle = this._settings.backgroundColor;
			canvasCtx.fillRect(0, 0, canvasWidth, canvasHeight);
		}

		const paintQueue = new PaintQueue(canvasCtx, this._settings.x, this._settings.w);
		for (let i = 0, len = decorations.length; i < len; i++) {
			const decoration = decorations[i];
			const opts = <ModelDecorationOverviewRulerOptions>decoration.source.options.overviewRuler;
			const lane = opts.position;
			if (lane === 0) {
				continue;
			}
			const startLineNumber = decoration.range.startLineNumber;
			const endLineNumber = decoration.range.endLineNumber;
			const color = resolveColor(opts, theme);

			let y1 = (viewLayout.getVerticalOffsetForLineNumber(startLineNumber) * heightRatio) | 0;
			let y2 = ((viewLayout.getVerticalOffsetForLineNumber(endLineNumber) + lineHeight) * heightRatio) | 0;
			let height = y2 - y1;
			if (height < minDecorationHeight) {
				let yCenter = ((y1 + y2) / 2) | 0;
				if (yCenter < halfMinDecorationHeight) {
					yCenter = halfMinDecorationHeight;
				} else if (yCenter + halfMinDecorationHeight > canvasHeight) {
					yCenter = canvasHeight - halfMinDecorationHeight;
				}
				y1 = yCenter - halfMinDecorationHeight;
				y2 = yCenter + halfMinDecorationHeight;
			}

			paintQueueAccept(paintQueue, color, y1, y2, lane);
		}
		for (let i = 0, len = paintQueue.req.length; i < len; i++) {
			paintQueueFlush(paintQueue, paintQueue.req[i]);
		}

		// Draw cursors
		if (!this._settings.hideCursor) {
			const cursorHeight = (2 * this._settings.pixelRatio) | 0;
			const halfCursorHeight = (cursorHeight / 2) | 0;
			const x = this._settings.x[OverviewRulerLane.Full];
			const w = this._settings.w[OverviewRulerLane.Full];
			canvasCtx.fillStyle = this._settings.cursorColor;
			for (let i = 0, len = this._cursorPositions.length; i < len; i++) {
				const cursor = this._cursorPositions[i];

				let yCenter = (viewLayout.getVerticalOffsetForLineNumber(cursor.lineNumber) * heightRatio) | 0;
				if (yCenter < halfCursorHeight) {
					yCenter = halfCursorHeight;
				} else if (yCenter + halfCursorHeight > canvasHeight) {
					yCenter = canvasHeight - halfCursorHeight;
				}
				const y1 = yCenter - halfCursorHeight;

				canvasCtx.fillRect(x, y1, w, cursorHeight);
			}
		}

		if (this._settings.renderBorder && this._settings.borderColor && this._settings.overviewRulerLanes > 0) {
			canvasCtx.beginPath();
			canvasCtx.lineWidth = 1;
			canvasCtx.strokeStyle = this._settings.borderColor;
			canvasCtx.moveTo(0, 0);
			canvasCtx.lineTo(0, canvasHeight);
			canvasCtx.stroke();

			canvasCtx.moveTo(0, 0);
			canvasCtx.lineTo(canvasWidth, 0);
			canvasCtx.stroke();
		}
	}
}

class PaintRequest {
	public color: string;
	public y1: number;
	public y2: number;
	public lane: number;

	public init(color: string, y1: number, y2: number, lane: number): void {
		this.color = color;
		this.y1 = y1;
		this.y2 = y2;
		this.lane = lane;
	}
}

class PaintQueue {
	readonly ctx: CanvasRenderingContext2D;

	readonly x: number[];
	readonly w: number[];

	readonly req: PaintRequest[] = [];
	readonly pool: PaintRequest[] = [];

	constructor(ctx: CanvasRenderingContext2D, x: number[], w: number[]) {
		this.ctx = ctx;
		this.x = x;
		this.w = w;
	}
}

function paintQueueAccept(Q: PaintQueue, color: string, y1: number, y2: number, lane: number): void {
	let result: PaintRequest = null;
	for (let i = 0, len = Q.req.length; i < len; i++) {
		const req = Q.req[i];
		if (req.y2 < y1) {
			paintQueueFlush(Q, req);

			if (i + 1 === len) {
				// last element
				Q.req.pop();
				Q.pool.push(req);
				break;
			} else {
				Q.req[i] = Q.req.pop();
				len--;
				Q.pool.push(req);
				i--;
				continue;
			}
		}

		if (req.lane === lane && req.color === color) {
			result = req;
			break;
		}
	}

	if (result !== null) {
		// there is already an ongoing request for this color & lane
		// => simply merge into it
		result.y2 = y2;
		return;
	}

	if (Q.pool.length > 0) {
		result = Q.pool.pop();
	} else {
		result = new PaintRequest();
	}

	result.init(color, y1, y2, lane);
	Q.req.push(result);
}

function paintQueueFlush(Q: PaintQueue, req: PaintRequest): void {
	Q.ctx.fillStyle = req.color;
	Q.ctx.fillRect(Q.x[req.lane], req.y1, Q.w[req.lane], req.y2 - req.y1);
}

function resolveColor(opts: ModelDecorationOverviewRulerOptions, theme: ITheme): string {
	if (!opts._resolvedColor) {
		const themeType = theme.type;
		const color = (themeType === 'dark' ? opts.darkColor : themeType === 'light' ? opts.color : opts.hcColor);
		opts._resolvedColor = resolveRulerColor(color, theme);
	}
	return opts._resolvedColor;
}

function resolveRulerColor(color: string | ThemeColor, theme: ITheme): string {
	if (typeof color === 'string') {
		return color;
	}
	let c = color ? theme.getColor(color.id) : null;
	if (!c) {
		c = Color.transparent;
	}
	return c.toString();
}
