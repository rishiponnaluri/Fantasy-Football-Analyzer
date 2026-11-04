import { notFound } from 'next/navigation';
import VisualPolishQA from './visual-polish-qa';

export default function VisualQA() {
  if (process.env.NODE_ENV !== 'development') notFound();
  return <VisualPolishQA/>;
}
