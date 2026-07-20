import * as React from 'react';

export interface NavProps {
  fixed?: boolean;
  styles?: React.CSSProperties;
  children?: React.ReactNode;
}
export declare const Nav: React.FC<NavProps>;

export interface MainProps {
  styles?: React.CSSProperties;
  children?: React.ReactNode;
}
export declare const Main: React.FC<MainProps>;

export interface ButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'style'> {
  styles?: React.CSSProperties;
}
export declare const Button: React.FC<ButtonProps>;

export interface ModalProps {
  show?: boolean | string | null;
  onClose?: () => void;
  styles?: React.CSSProperties;
  children?: React.ReactNode;
}
export declare const Modal: React.FC<ModalProps>;
