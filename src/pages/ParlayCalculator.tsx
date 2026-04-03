import React from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import ParlayPlanDetailContent from '../components/ParlayPlanDetailContent';

const ParlayCalculator: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();

  return (
    <ParlayPlanDetailContent
      id={id}
      initialBaseType={(searchParams.get('base_type') || 'jingcai') as 'jingcai' | 'crown'}
      showTitle
    />
  );
};

export default ParlayCalculator;
