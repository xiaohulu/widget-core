import { Evented, BaseEventedEvents } from '@dojo/core/Evented';
import { EventedListenerOrArray } from '@dojo/interfaces/bases';
import { Handle } from '@dojo/interfaces/core';
import { VNode, ProjectionOptions, VNodeProperties } from '@dojo/interfaces/vdom';
import Map from '@dojo/shim/Map';
import Promise from '@dojo/shim/Promise';
import Set from '@dojo/shim/Set';
import WeakMap from '@dojo/shim/WeakMap';
import { v, registry, isWNode, isHNode, decorate } from './d';
import diff, { DiffType } from './diff';
import {
	DNode,
	WidgetBaseConstructor,
	WidgetProperties,
	WidgetBaseInterface,
	PropertyChangeRecord,
	PropertiesChangeEvent,
	HNode
} from './interfaces';
import { isWidgetBaseConstructor, WIDGET_BASE_TYPE } from './WidgetRegistry';
import RegistryHandler from './RegistryHandler';

export { DiffType };

/**
 * Widget cache wrapper for instance management
 */
interface WidgetCacheWrapper {
	child: WidgetBaseInterface<WidgetProperties>;
	widgetConstructor: WidgetBaseConstructor;
	used: boolean;
}

/**
 * Diff property configuration
 */
interface DiffPropertyConfig {
	propertyName: string;
	diffType: DiffType;
	diffFunction?<P>(previousProperty: P, newProperty: P): PropertyChangeRecord;
}

export interface WidgetBaseEvents<P extends WidgetProperties> extends BaseEventedEvents {
	(type: 'properties:changed', handler: EventedListenerOrArray<WidgetBase<P>, PropertiesChangeEvent<WidgetBase<P>, P>>): Handle;
}

const decoratorMap = new Map<Function, Map<string, any[]>>();

/**
 * Decorator that can be used to register a function to run as an aspect to `render`
 */
export function afterRender(method: Function): (target: any) => void;
export function afterRender(): (target: any, propertyKey: string) => void;
export function afterRender(method?: Function) {
	return handleDecorator((target, propertyKey) => {
		target.addDecorator('afterRender', propertyKey ? target[propertyKey] : method);
	});
}

/**
 * Decorator that can be used to register a reducer function to run as an aspect before to `render`
 */
export function beforeRender(method: Function): (target: any) => void;
export function beforeRender(): (target: any, propertyKey: string) => void;
export function beforeRender(method?: Function) {
	return handleDecorator((target, propertyKey) => {
		target.addDecorator('beforeRender', propertyKey ? target[propertyKey] : method);
	});
}

/**
 * Decorator that can be used to register a function as a specific property diff
 *
 * @param propertyName  The name of the property of which the diff function is applied
 * @param diffType      The diff type, default is DiffType.AUTO.
 * @param diffFunction  A diff function to run if diffType if DiffType.CUSTOM
 */
export function diffProperty(propertyName: string, diffType = DiffType.AUTO, diffFunction?: Function) {
	return handleDecorator((target, propertyKey) => {
		target.addDecorator('diffProperty', {
			propertyName,
			diffType: propertyKey ? DiffType.CUSTOM : diffType,
			diffFunction: propertyKey ? target[propertyKey] : diffFunction
		});
	});
}

/**
 * Decorator used to register listeners to the `properties:changed` event.
 */
export function onPropertiesChanged(method: Function): (target: any) => void;
export function onPropertiesChanged(): (target: any, propertyKey: any) => void;
export function onPropertiesChanged(method?: Function) {
	return handleDecorator((target, propertyKey) => {
		target.addDecorator('onPropertiesChanged', propertyKey ? target[propertyKey] : method);
	});
}

/**
 * Generic decorator handler to take care of whether or not the decorator was called at the class level
 * or the method level.
 *
 * @param handler
 */
export function handleDecorator(handler: (target: any, propertyKey?: string) => void) {
	return function (target: any, propertyKey?: string, descriptor?: PropertyDescriptor) {
		if (typeof target === 'function') {
			handler(target.prototype, undefined);
		}
		else {
			handler(target, propertyKey);
		}
	};
}

/**
 * Function that identifies DNodes that are HNodes with key properties.
 */
function isHNodeWithKey(node: DNode): node is HNode {
	return isHNode(node) && (node.properties != null) && (node.properties.key != null);
}

/**
 * Main widget base for all widgets to extend
 */
@diffProperty('bind', DiffType.REFERENCE)
export class WidgetBase<P extends WidgetProperties = WidgetProperties, C extends DNode = DNode> extends Evented implements WidgetBaseInterface<P, C> {

	/**
	 * static identifier
	 */
	static _type: symbol = WIDGET_BASE_TYPE;

	/**
	 * on for the events defined for widget base
	 */
	public on: WidgetBaseEvents<P>;

	/**
	 * children array
	 */
	private _children: (C | null)[];

	/**
	 * marker indicating if the widget requires a render
	 */
	private _dirty: boolean;

	/**
	 * cachedVNode from previous render
	 */
	private _cachedVNode?: VNode | string;

	/**
	 * internal widget properties
	 */
	private  _properties: P;

	/**
	 * properties from the previous render
	 */
	private _previousProperties: P & { [index: string]: any };

	/**
	 * cached chldren map for instance management
	 */
	private _cachedChildrenMap: Map<string | Promise<WidgetBaseConstructor> | WidgetBaseConstructor, WidgetCacheWrapper[]>;

	/**
	 * map of specific property diff functions
	 */
	private _diffPropertyFunctionMap: Map<string, string>;

	/**
	 * map of decorators that are applied to this widget
	 */
	private _decoratorCache: Map<string, any[]>;

	/**
	 * set of render decorators
	 */
	private _renderDecorators: Set<string>;

	private _registries: RegistryHandler;

	/**
	 * Map of functions properties for the bound function
	 */
	private _bindFunctionPropertyMap: WeakMap<(...args: any[]) => any, { boundFunc: (...args: any[]) => any, scope: any }>;

	/**
	 * @constructor
	 */
	constructor() {
		super({});

		this._children = [];
		this._decoratorCache = new Map<string, any[]>();
		this._properties = <P> {};
		this._previousProperties = <P> {};
		this._cachedChildrenMap = new Map<string | Promise<WidgetBaseConstructor> | WidgetBaseConstructor, WidgetCacheWrapper[]>();
		this._diffPropertyFunctionMap = new Map<string, string>();
		this._renderDecorators = new Set<string>();
		this._bindFunctionPropertyMap = new WeakMap<(...args: any[]) => any, { boundFunc: (...args: any[]) => any, scope: any }>();
		this._registries = new RegistryHandler();
		this._registries.add(registry);
		this.own(this._registries);

		this.own(this._registries.on('invalidate', this.invalidate.bind(this)));

		this.own(this.on('properties:changed', (evt) => {
			this._dirty = true;

			const propertiesChangedListeners = this.getDecorator('onPropertiesChanged');
			propertiesChangedListeners.forEach((propertiesChangedFunction) => {
				propertiesChangedFunction.call(this, evt);
			});
		}));
	}

	/**
	 * A render decorator that registers vnode callbacks for 'afterCreate' and
	 * 'afterUpdate' that will in turn call lifecycle methods onElementCreated and onElementUpdated.
	 */
	@afterRender()
	protected attachLifecycleCallbacks (node: DNode): DNode {
		// Create vnode afterCreate and afterUpdate callback functions that will only be set on nodes
		// with "key" properties.

		decorate(node, (node: HNode) => {
			node.properties.afterCreate = this.afterCreateCallback;
			node.properties.afterUpdate = this.afterUpdateCallback;
		}, isHNodeWithKey);

		return node;
	}

	/**
	 * vnode afterCreate callback that calls the onElementCreated lifecycle method.
	 */
	private afterCreateCallback(element: Element, projectionOptions: ProjectionOptions, vnodeSelector: string,
		properties: VNodeProperties, children: VNode[]): void {
		this.onElementCreated(element, String(properties.key));
	}

	/**
	 * vnode afterUpdate callback that calls the onElementUpdated lifecycle method.
	 */
	private afterUpdateCallback(element: Element, projectionOptions: ProjectionOptions, vnodeSelector: string,
		properties: VNodeProperties, children: VNode[]): void {
		this.onElementUpdated(element, String(properties.key));
	}

	/**
	 * Widget lifecycle method that is called whenever a dom node is created for a vnode.
	 * Override this method to access the dom nodes that were inserted into the dom.
	 * @param element The dom node represented by the vdom node.
	 * @param key The vdom node's key.
	 */
	protected onElementCreated(element: Element, key: string): void {
		// Do nothing by default.
	}

	/**
	 * Widget lifecycle method that is called whenever a dom node that is associated with a vnode is updated.
	 * Note: this method is dependant on the Maquette afterUpdate callback which is called if a dom
	 * node might have been updated.  Maquette does not guarantee the dom node was updated.
	 * Override this method to access the dom node.
	 * @param element The dom node represented by the vdom node.
	 * @param key The vdom node's key.
	 */
	protected onElementUpdated(element: Element, key: string): void {
		// Do nothing by default.
	}

	public get properties(): Readonly<P> {
		return this._properties;
	}

	public __setProperties__(properties: P): void {
		const diffPropertyResults: { [index: string]: any } = {};
		const diffPropertyChangedKeys: string[] = [];

		this.bindFunctionProperties(properties);

		const registeredDiffPropertyConfigs: DiffPropertyConfig[] = this.getDecorator('diffProperty');

		const allProperties = [...Object.keys(this._previousProperties), ...Object.keys(properties)].filter((value, index, self) => {
			return self.indexOf(value) === index;
		});

		const propertyDiffHandlers = allProperties.reduce((diffFunctions: any, propertyName) => {
			diffFunctions[propertyName] = [
				...registeredDiffPropertyConfigs.filter(value => {
					return value.propertyName === propertyName;
				})
			];

			return diffFunctions;
		}, {});

		allProperties.forEach(propertyName => {
			const previousValue = this._previousProperties[propertyName];
			const newValue = (<any> properties)[propertyName];
			const diffHandlers = propertyDiffHandlers[propertyName];
			let result: PropertyChangeRecord = {
				changed: false,
				value: newValue
			};

			if (diffHandlers.length) {
				for (let i = 0; i < diffHandlers.length; i++) {
					const { diffFunction, diffType } = diffHandlers[i];

					const meta = {
						diffFunction: diffFunction,
						scope: this
					};

					result = diff(propertyName, diffType, previousValue, newValue, meta);

					if (result.changed) {
						break;
					}
				}
			}
			else {
				result = diff(propertyName, DiffType.AUTO, previousValue, newValue);
			}

			if (propertyName in properties) {
				diffPropertyResults[propertyName] = result.value;
			}

			if (result.changed) {
				diffPropertyChangedKeys.push(propertyName);
			}
		});

		this._properties = <P> diffPropertyResults;

		if (diffPropertyChangedKeys.length) {
			this.emit({
				type: 'properties:changed',
				target: this,
				properties: this.properties,
				changedPropertyKeys: diffPropertyChangedKeys
			});
		}
		this._previousProperties = this.properties;
	}

	public get children(): (C | null)[] {
		return this._children;
	}

	public __setChildren__(children: (C | null)[]): void {
		this._dirty = true;
		this._children = children;
		this.emit({
			type: 'widget:children',
			target: this
		});
	}

	public __render__(): VNode | string | null {
		if (this._dirty || !this._cachedVNode) {
			this._dirty = false;
			const beforeRenders = this.getDecorator('beforeRender');
			const render = beforeRenders.reduce((render, beforeRenderFunction) => {
				return beforeRenderFunction.call(this, render, this._properties, this._children);
			}, this.render.bind(this));
			let dNode = render();
			const afterRenders = this.getDecorator('afterRender');
			afterRenders.forEach((afterRenderFunction: Function) => {
				dNode = afterRenderFunction.call(this, dNode);
			});
			const widget = this.dNodeToVNode(dNode);
			this.manageDetachedChildren();
			if (widget) {
				this._cachedVNode = widget;
			}
			return widget;
		}
		return this._cachedVNode;
	}

	public invalidate(): void {
		this._dirty = true;
		this.emit({
			type: 'invalidated',
			target: this
		});
	}

	protected render(): DNode {
		return v('div', {}, this.children);
	}

	/**
	 * Function to add decorators to WidgetBase
	 *
	 * @param decoratorKey The key of the decorator
	 * @param value The value of the decorator
	 */
	protected addDecorator(decoratorKey: string, value: any): void {
		value = Array.isArray(value) ? value : [ value ];
		if (this.hasOwnProperty('constructor')) {
			let decoratorList = decoratorMap.get(this.constructor);
			if (!decoratorList) {
				decoratorList = new Map<string, any[]>();
				decoratorMap.set(this.constructor, decoratorList);
			}

			let specificDecoratorList = decoratorList.get(decoratorKey);
			if (!specificDecoratorList) {
				specificDecoratorList = [];
				decoratorList.set(decoratorKey, specificDecoratorList);
			}
			specificDecoratorList.push(...value);
		}
		else {
			const decorators = this._decoratorCache.get(decoratorKey) || [];
			this._decoratorCache.set(decoratorKey, [ ...decorators, ...value ]);
		}
	}

	/**
	 * Function to build the list of decorators from the global decorator map.
	 *
	 * @param decoratorKey  The key of the decorator
	 * @return An array of decorator values
	 * @private
	 */
	private _buildDecoratorList(decoratorKey: string): any[] {
		const allDecorators = [];

		let constructor = this.constructor;

		while (constructor) {
			const instanceMap = decoratorMap.get(constructor);
			if (instanceMap) {
				const decorators = instanceMap.get(decoratorKey);

				if (decorators) {
					allDecorators.unshift(...decorators);
				}
			}

			constructor = Object.getPrototypeOf(constructor);
		}

		return allDecorators;
	}

	/**
	 * Function to retrieve decorator values
	 *
	 * @param decoratorKey The key of the decorator
	 * @returns An array of decorator values
	 */
	protected getDecorator(decoratorKey: string): any[] {
		let allDecorators = this._decoratorCache.get(decoratorKey);

		if (allDecorators !== undefined) {
			return allDecorators;
		}

		allDecorators = this._buildDecoratorList(decoratorKey);

		this._decoratorCache.set(decoratorKey, allDecorators);

		return allDecorators;
	}

	/**
	 * Binds unbound property functions to the specified `bind` property
	 *
	 * @param properties properties to check for functions
	 */
	private bindFunctionProperties(properties: P & { [index: string]: any }): void {
		Object.keys(properties).forEach((propertyKey) => {
			const property = properties[propertyKey];
			const bind = properties.bind;

			if (typeof property === 'function' && !isWidgetBaseConstructor(property)) {
				const bindInfo = this._bindFunctionPropertyMap.get(property) || {};
				let { boundFunc, scope } = bindInfo;

				if (!boundFunc || scope !== bind) {
					boundFunc = property.bind(bind);
					this._bindFunctionPropertyMap.set(property, { boundFunc, scope: bind });
				}
				properties[propertyKey] = boundFunc;
			}
		});
	}

	protected get registries(): RegistryHandler {
		return this._registries;
	}

	/**
	 * Process a structure of DNodes into VNodes, string or null. `null` results are filtered.
	 *
	 * @param dNode the dnode to process
	 * @returns a VNode, string or null
	 */
	private dNodeToVNode(dNode: DNode): VNode | string | null {

		if (typeof dNode === 'string' || dNode === null) {
			return dNode;
		}

		if (isWNode(dNode)) {
			const { children, properties = {} } = dNode;
			const { key } = properties;

			let { widgetConstructor } = dNode;
			let child: WidgetBaseInterface<WidgetProperties>;

			if (typeof widgetConstructor === 'string') {
				const item = this._registries.get(widgetConstructor);
				if (item === null) {
					return null;
				}
				widgetConstructor = <WidgetBaseConstructor> item;
			}

			const childrenMapKey = key || widgetConstructor;
			let cachedChildren = this._cachedChildrenMap.get(childrenMapKey) || [];
			let cachedChild: WidgetCacheWrapper | undefined;
			cachedChildren.some((cachedChildWrapper) => {
				if (cachedChildWrapper.widgetConstructor === widgetConstructor && !cachedChildWrapper.used) {
					cachedChild = cachedChildWrapper;
					return true;
				}
				return false;
			});

			if (!properties.hasOwnProperty('bind')) {
				properties.bind = this;
			}

			if (cachedChild) {
				child = cachedChild.child;
				child.__setProperties__(properties);
				cachedChild.used = true;
			}
			else {
				child = new widgetConstructor();
				child.__setProperties__(properties);
				child.own(child.on('invalidated', () => {
					this.invalidate();
				}));
				cachedChildren = [...cachedChildren, { child, widgetConstructor, used: true }];
				this._cachedChildrenMap.set(childrenMapKey, cachedChildren);
				this.own(child);
			}
			if (!key && cachedChildren.length > 1) {
				const errorMsg = 'It is recommended to provide a unique `key` property when using the same widget multiple times';
				console.warn(errorMsg);
				this.emit({ type: 'error', target: this, error: new Error(errorMsg) });
			}

			if (Array.isArray(children)) {
				child.__setChildren__(children);
			}
			return child.__render__();
		}

		dNode.vNodes = dNode.children
		.filter((child) => child !== null)
		.map((child: DNode) => {
			return this.dNodeToVNode(child);
		});

		return dNode.render({ bind: this });
	}

	/**
	 * Manage widget instances after render processing
	 */
	private manageDetachedChildren(): void {
		this._cachedChildrenMap.forEach((cachedChildren, key) => {
			const filterCachedChildren = cachedChildren.filter((cachedChild) => {
				if (cachedChild.used) {
					cachedChild.used = false;
					return true;
				}
				cachedChild.child.destroy();
				return false;
			});
			this._cachedChildrenMap.set(key, filterCachedChildren);
		});
	}
}

export default WidgetBase;
