import React, { useEffect } from 'react';
import { Button, Col, DatePicker, Divider, Form, Input, InputNumber, Modal, Row } from 'antd';
import { MinusCircleOutlined, PlusOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';

interface MatchModalProps {
  visible: boolean;
  onCancel: () => void;
  onFinish: (values: any) => Promise<void>;
  initialValues?: any;
  title?: string;
}

const MatchModal: React.FC<MatchModalProps> = ({
  visible,
  onCancel,
  onFinish,
  initialValues,
  title = '手动添加比赛',
}) => {
  const [form] = Form.useForm();

  useEffect(() => {
    if (!visible) return;

    if (initialValues) {
      form.setFieldsValue({
        ...initialValues,
        match_time: initialValues.match_time ? dayjs(initialValues.match_time) : undefined,
      });
      return;
    }

    form.resetFields();
  }, [visible, initialValues, form]);

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      await onFinish({
        ...values,
        match_time: values.match_time ? values.match_time.format('YYYY-MM-DD HH:mm:ss') : undefined,
      });
      form.resetFields();
    } catch (error) {
      console.error('Validation failed:', error);
    }
  };

  return (
    <Modal title={title} open={visible} onCancel={onCancel} onOk={handleSubmit} width={860} destroyOnHidden>
      <Form form={form} layout="vertical">
        <Row gutter={12}>
          <Col span={8}>
            <Form.Item label="赛事" name="league" rules={[{ required: true, message: '请输入赛事名称' }]}>
              <Input placeholder="如：英超" />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item label="轮次" name="round">
              <Input placeholder="如：第28轮" />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item label="比赛时间" name="match_time" rules={[{ required: true, message: '请选择比赛时间' }]}>
              <DatePicker showTime style={{ width: '100%' }} />
            </Form.Item>
          </Col>
        </Row>

        <Row gutter={12}>
          <Col span={12}>
            <Form.Item label="主队" name="home_team" rules={[{ required: true, message: '请输入主队名称' }]}>
              <Input />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item label="客队" name="away_team" rules={[{ required: true, message: '请输入客队名称' }]}>
              <Input />
            </Form.Item>
          </Col>
        </Row>

        <Divider>竞彩普通胜平负</Divider>
        <Row gutter={8}>
          <Col span={6}>
            <Form.Item label="普通让球" name="handicap">
              <Input placeholder="如：+1 / -0.5" />
            </Form.Item>
          </Col>
          <Col span={6}>
            <Form.Item label="竞彩胜" name="j_w">
              <InputNumber style={{ width: '100%' }} step={0.01} />
            </Form.Item>
          </Col>
          <Col span={6}>
            <Form.Item label="竞彩平" name="j_d">
              <InputNumber style={{ width: '100%' }} step={0.01} />
            </Form.Item>
          </Col>
          <Col span={6}>
            <Form.Item label="竞彩负" name="j_l">
              <InputNumber style={{ width: '100%' }} step={0.01} />
            </Form.Item>
          </Col>
        </Row>

        <Divider>竞彩让球胜平负</Divider>
        <Row gutter={8}>
          <Col span={6}>
            <Form.Item label="竞彩让球" name="jc_handicap">
              <Input placeholder="如：-1 / +1" />
            </Form.Item>
          </Col>
          <Col span={6}>
            <Form.Item label="让球胜" name="j_hw">
              <InputNumber style={{ width: '100%' }} step={0.01} />
            </Form.Item>
          </Col>
          <Col span={6}>
            <Form.Item label="让球平" name="j_hd">
              <InputNumber style={{ width: '100%' }} step={0.01} />
            </Form.Item>
          </Col>
          <Col span={6}>
            <Form.Item label="让球负" name="j_hl">
              <InputNumber style={{ width: '100%' }} step={0.01} />
            </Form.Item>
          </Col>
        </Row>

        <Divider>皇冠标准盘</Divider>
        <Row gutter={8}>
          <Col span={8}>
            <Form.Item label="皇冠胜" name="c_w">
              <InputNumber style={{ width: '100%' }} step={0.01} />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item label="皇冠平" name="c_d">
              <InputNumber style={{ width: '100%' }} step={0.01} />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item label="皇冠负" name="c_l">
              <InputNumber style={{ width: '100%' }} step={0.01} />
            </Form.Item>
          </Col>
        </Row>

        <Divider>皇冠亚盘</Divider>
        <Form.List name="c_h">
          {(fields, { add, remove }) => (
            <>
              {fields.map(({ key, name, ...restField }) => (
                <div
                  key={key}
                  style={{
                    marginBottom: 12,
                    padding: 10,
                    background: '#fafafa',
                    borderRadius: 4,
                    border: '1px solid #f0f0f0',
                  }}
                >
                  <Row gutter={8} align="middle">
                    <Col span={7}>
                      <Form.Item
                        {...restField}
                        label="盘口"
                        name={[name, 'type']}
                        rules={[{ required: true, message: '请输入盘口' }]}
                        style={{ marginBottom: 0 }}
                      >
                        <Input placeholder="如：-0.5 / +0/0.5" />
                      </Form.Item>
                    </Col>
                    <Col span={7}>
                      <Form.Item
                        {...restField}
                        label="主队赔率"
                        name={[name, 'home_odds']}
                        rules={[{ required: true, message: '请输入主队赔率' }]}
                        style={{ marginBottom: 0 }}
                      >
                        <InputNumber style={{ width: '100%' }} step={0.01} />
                      </Form.Item>
                    </Col>
                    <Col span={7}>
                      <Form.Item
                        {...restField}
                        label="客队赔率"
                        name={[name, 'away_odds']}
                        rules={[{ required: true, message: '请输入客队赔率' }]}
                        style={{ marginBottom: 0 }}
                      >
                        <InputNumber style={{ width: '100%' }} step={0.01} />
                      </Form.Item>
                    </Col>
                    <Col span={3} style={{ textAlign: 'center', paddingTop: 22 }}>
                      <MinusCircleOutlined onClick={() => remove(name)} style={{ fontSize: 18, color: '#ff4d4f' }} />
                    </Col>
                  </Row>
                </div>
              ))}
              <Form.Item>
                <Button type="dashed" onClick={() => add()} block icon={<PlusOutlined />}>
                  添加皇冠亚盘
                </Button>
              </Form.Item>
            </>
          )}
        </Form.List>
      </Form>
    </Modal>
  );
};

export default MatchModal;
