import React from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import SinglePlanDetailContent from '../components/SinglePlanDetailContent';

const Calculator: React.FC = () => {
  const { matchId } = useParams<{ matchId: string }>();
  const [searchParams] = useSearchParams();

  return (
    <SinglePlanDetailContent
      matchId={matchId}
      initialBaseType={(searchParams.get('base_type') || 'jingcai') as 'jingcai' | 'crown'}
      showTitle
    />
  );
};

export default Calculator;
