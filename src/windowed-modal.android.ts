import { AndroidActivityBackPressedEventData, Application, Color, Screen, View } from "@nativescript/core";
import { ExtendedShowModalOptions } from "./windowed-modal.common";

// tslint:disable-next-line:no-implicit-dependencies
const modalMap = new Map<number, CustomDialogOptions>();

const DOMID = "_domId";

const styleAnimationDialog = 16973826; // android.R.style.Animation_Dialog

function saveModal(options: CustomDialogOptions) {
    modalMap.set(options.owner._domId, options);
}

function removeModal(domId: number) {
    modalMap.delete(domId);
}

function getModalOptions(domId: number): CustomDialogOptions {
    return modalMap.get(domId);
}

let DialogFragment;

interface CustomDialogOptions {
    owner: View;
    fullscreen: boolean;
    animated: boolean;
    stretched: boolean;
    cancelable: boolean;
    shownCallback: () => void;
    dismissCallback: () => void;
    dimAmount: number;
}

export function overrideModalViewMethod(): void {
    (View as any).prototype._showNativeModalView = androidModal;
}

// https://github.com/NativeScript/NativeScript/blob/master/tns-core-modules/ui/core/view/view.android.ts
function androidModal(parent: any, options: ExtendedShowModalOptions) {
    (<any>View).prototype._showNativeModalView.call(this, parent, options);

    const backgroundColor: Color = this.backgroundColor;
    const dimAmount = options.dimAmount !== undefined ? options.dimAmount : 0.5;

    this.backgroundColor = backgroundColor ?
        new Color(255 * dimAmount, backgroundColor.r, backgroundColor.g, backgroundColor.b) :
        new Color(255 * dimAmount, 0, 0, 0);

    this.width = Screen.mainScreen.widthDIPs + 1;
    this.height = Screen.mainScreen.heightDIPs + 1;
    this.horizontalAlignment = "stretch";
    this.verticalAlignment = "stretch";

    this._setupUI(parent._context);
    this._isAddedToNativeVisualTree = true;

    const initializeDialogFragment = () => {
        if (DialogFragment) {
            return;
        }

        @NativeClass
        class DialogImpl extends android.app.Dialog {
            constructor(public fragment: DialogFragmentImpl, context: android.content.Context, themeResId: number) {
                super(context, themeResId);

                return global.__native(this);
            }

            public onDetachedFromWindow(): void {
                super.onDetachedFromWindow();
                this.fragment = null;
            }

            public onBackPressed(): void {
                const view = this.fragment.owner;
                const args = <AndroidActivityBackPressedEventData>{
                    eventName: 'activityBackPressed',
                    object: view,
                    activity: view._context,
                    cancel: false,
                };

                // Fist fire application.android global event
                Application.android.notify(args);
                if (args.cancel) {
                    return;
                }

                view.notify(args);

                if (!args.cancel && !view.onBackPressed()) {
                    super.onBackPressed();
                }
            }
        }

        @NativeClass
        class DialogFragmentImpl extends androidx.fragment.app.DialogFragment {
            public owner: View;
            private _fullscreen: boolean;
            private _animated: boolean;
            private _stretched: boolean;
            private _cancelable: boolean;
            private _shownCallback: () => void;
            private _dismissCallback: () => void;

            constructor() {
                super();

                return global.__native(this);
            }

            public onCreateDialog(savedInstanceState: android.os.Bundle): android.app.Dialog {
                const ownerId = this.getArguments().getInt(DOMID);
                const options = getModalOptions(ownerId);
                this.owner = options.owner;
                // Set owner._dialogFragment to this in case the DialogFragment was recreated after app suspend
                (this.owner as any)._dialogFragment = this;
                this._fullscreen = options.fullscreen;
                this._animated = options.animated;
                this._cancelable = options.cancelable;
                this._stretched = options.stretched;
                this._dismissCallback = options.dismissCallback;
                this._shownCallback = options.shownCallback;
                this.setStyle(androidx.fragment.app.DialogFragment.STYLE_NO_TITLE, 0);

                let theme = this.getTheme();
                if (this._fullscreen) {
                    // In fullscreen mode, get the application's theme.
                    theme = this.getActivity().getApplicationInfo().theme;
                }

                const dialog = new DialogImpl(this, this.getActivity(), theme);

                // do not override alignment unless fullscreen modal will be shown;
                // otherwise we might break component-level layout:
                // https://github.com/NativeScript/NativeScript/issues/5392
                if (!this._fullscreen && !this._stretched) {
                    this.owner.horizontalAlignment = 'center';
                    this.owner.verticalAlignment = 'middle';
                } else {
                    this.owner.horizontalAlignment = 'stretch';
                    this.owner.verticalAlignment = 'stretch';
                }

                // set the modal window animation
                // https://github.com/NativeScript/NativeScript/issues/5989
                if (this._animated) {
                    dialog.getWindow().setWindowAnimations(styleAnimationDialog);
                }

                dialog.setCanceledOnTouchOutside(this._cancelable);

                const window = dialog.getWindow();
                window.setBackgroundDrawable(new android.graphics.drawable.ColorDrawable(android.graphics.Color.TRANSPARENT));
                window.setDimAmount(options.dimAmount);

                return dialog;
            }

            public onCreateView(inflater: android.view.LayoutInflater, container: android.view.ViewGroup, savedInstanceState: android.os.Bundle): android.view.View {
                const owner = this.owner;
                owner._setupAsRootView(this.getActivity());
                owner._isAddedToNativeVisualTree = true;

                return owner.nativeViewProtected;
            }

            public onStart(): void {
                super.onStart();
                if (this._fullscreen) {
                    const window = this.getDialog().getWindow();
                    const length = android.view.ViewGroup.LayoutParams.MATCH_PARENT;
                    window.setLayout(length, length);
                    // This removes the default backgroundDrawable so there are no margins.
                    window.setBackgroundDrawable(new android.graphics.drawable.ColorDrawable(android.graphics.Color.WHITE));
                }

                const owner = this.owner;
                if (owner && !owner.isLoaded) {
                    owner.callLoaded();
                }

                this._shownCallback();
            }

            public onDismiss(dialog: android.content.DialogInterface): void {
                super.onDismiss(dialog);
                const manager = this.getFragmentManager();
                if (manager) {
                    removeModal(this.owner._domId);
                    this._dismissCallback();
                }

                const owner = this.owner;
                if (owner && owner.isLoaded) {
                    owner.callUnloaded();
                }
            }

            public onDestroy(): void {
                super.onDestroy();
                const owner = this.owner;

                if (owner) {
                    // Android calls onDestroy before onDismiss.
                    // Make sure we unload first and then call _tearDownUI.
                    if (owner.isLoaded) {
                        owner.callUnloaded();
                    }

                    owner._isAddedToNativeVisualTree = false;
                    owner._tearDownUI(true);
                }
            }
        }

        DialogFragment = DialogFragmentImpl;
    }

    initializeDialogFragment();
    const df = new DialogFragment();
    const args = new android.os.Bundle();
    args.putInt(DOMID, this._domId);
    df.setArguments(args);

    let cancelable = true;

    if (options.android && (<any>options).android.cancelable !== undefined) {
        cancelable = !!(<any>options).android.cancelable;
        console.log('ShowModalOptions.android.cancelable is deprecated. Use ShowModalOptions.cancelable instead.');
    }

    cancelable = options.cancelable !== undefined ? !!options.cancelable : cancelable;

    const dialogOptions: CustomDialogOptions = {
        owner: this,
        fullscreen: !!options.fullscreen,
        animated: !!options.animated,
        stretched: !!options.stretched,
        cancelable: cancelable,
        shownCallback: () => this._raiseShownModallyEvent(),
        dismissCallback: () => this.closeModal(),
        dimAmount: options.dimAmount !== undefined ? +options.dimAmount : 0.5,
    };

    saveModal(dialogOptions);

    this._dialogFragment = df;
    this._raiseShowingModallyEvent();

    this._dialogFragment.show(parent._getRootFragmentManager(), this._domId.toString());
}
